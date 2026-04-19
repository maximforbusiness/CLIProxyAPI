// Command loadtest_models runs a moderate real-request load test against all
// models returned by /v1/models and prints a per-model reliability summary.
//
// Usage:
//
//	go run ./cmd/loadtest_models \
//	  --base-url http://127.0.0.1:8318 \
//	  --api-key YOUR_KEY \
//	  --requests-per-model 3 \
//	  --concurrency 3 \
//	  --mode auto
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"text/tabwriter"
	"time"
)

const (
	classBlocked      = "blocked"
	classCooldown     = "cooldown"
	classUnauthorized = "unauthorized"
	classQuota        = "quota"
	classTransient    = "transient"
	classUnsupported  = "unsupported"
	classOther        = "other"
)

var (
	retryAfterTextPattern  = regexp.MustCompile(`(?i)(?:retry(?:\s*[-_]?after)?|try again(?:\s+in)?|cooldown|reset(?:\s+after|\s+in)?|available(?:\s+in)?|wait(?:\s+for)?)\D{0,24}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b`)
	retryAfterPlainPattern = regexp.MustCompile(`(?i)(?:retry(?:\s*[-_]?after)?|cooldown|reset(?:\s+after|\s+in)?|wait(?:\s+for)?)\D{0,8}(\d+(?:\.\d+)?)\b`)
)

type modelListResponse struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

type mode string

const (
	modeAuto      mode = "auto"
	modeChat      mode = "chat"
	modeResponses mode = "responses"
)

type job struct {
	Model   string
	Attempt int
}

type runResult struct {
	Model        string
	Duration     time.Duration
	Status       int
	Success      bool
	Class        string
	ErrMessage   string
	ModeUsed     string
	RetryAfter   time.Duration
	Attempt      int
	RawBodyShort string
}

type modelStats struct {
	Total       int
	Success     int
	Failures    int
	ClassCounts map[string]int
	Statuses    map[int]int
	Durations   []time.Duration
	RetryAfter  []time.Duration
}

func main() {
	var (
		baseURL          string
		apiKey           string
		modelsPath       string
		chatPath         string
		responsesPath    string
		requestsPerModel int
		concurrency      int
		timeout          time.Duration
		pause            time.Duration
		maxTokens        int
		temperature      float64
		prompt           string
		modeFlag         string
		includePattern   string
		excludePattern   string
		limit            int
		listOnly         bool
		jsonOut          string
	)

	flag.StringVar(&baseURL, "base-url", "http://127.0.0.1:8318", "Proxy base URL")
	flag.StringVar(&apiKey, "api-key", "", "API key for Authorization: Bearer <key> (optional)")
	flag.StringVar(&modelsPath, "models-path", "/v1/models", "Models listing path")
	flag.StringVar(&chatPath, "chat-path", "/v1/chat/completions", "Chat completions path")
	flag.StringVar(&responsesPath, "responses-path", "/v1/responses", "Responses API path")
	flag.IntVar(&requestsPerModel, "requests-per-model", 3, "Requests to execute per model")
	flag.IntVar(&concurrency, "concurrency", 3, "Concurrent workers")
	flag.DurationVar(&timeout, "timeout", 45*time.Second, "Per-request timeout")
	flag.DurationVar(&pause, "pause", 150*time.Millisecond, "Pause between worker requests")
	flag.IntVar(&maxTokens, "max-tokens", 48, "max_tokens (chat) / max_output_tokens (responses)")
	flag.Float64Var(&temperature, "temperature", 0.0, "Request temperature")
	flag.StringVar(&prompt, "prompt", "Reply with exactly: ok", "Prompt used for test requests")
	flag.StringVar(&modeFlag, "mode", string(modeAuto), "Request mode: auto, chat, responses")
	flag.StringVar(&includePattern, "include", "", "Regex include filter for model IDs")
	flag.StringVar(&excludePattern, "exclude", "", "Regex exclude filter for model IDs")
	flag.IntVar(&limit, "limit", 0, "Limit number of models after filtering (0 = no limit)")
	flag.BoolVar(&listOnly, "list-only", false, "Only list models and exit")
	flag.StringVar(&jsonOut, "json-out", "", "Optional path to write JSON summary")
	flag.Parse()

	if apiKey == "" {
		apiKey = strings.TrimSpace(firstNonEmptyEnv("OPENAI_API_KEY", "CLIPROXY_API_KEY", "API_KEY"))
	}
	if requestsPerModel < 1 {
		requestsPerModel = 1
	}
	if concurrency < 1 {
		concurrency = 1
	}
	if maxTokens < 1 {
		maxTokens = 1
	}
	if timeout <= 0 {
		timeout = 45 * time.Second
	}
	if pause < 0 {
		pause = 0
	}

	runMode := mode(strings.ToLower(strings.TrimSpace(modeFlag)))
	switch runMode {
	case modeAuto, modeChat, modeResponses:
	default:
		fmt.Fprintf(os.Stderr, "invalid mode %q (expected: auto|chat|responses)\n", modeFlag)
		os.Exit(2)
	}

	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		fmt.Fprintln(os.Stderr, "base-url is required")
		os.Exit(2)
	}

	includeRE, err := compileOptionalRegex(includePattern)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid --include regex: %v\n", err)
		os.Exit(2)
	}
	excludeRE, err := compileOptionalRegex(excludePattern)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid --exclude regex: %v\n", err)
		os.Exit(2)
	}

	client := &http.Client{Timeout: timeout}
	ctx := context.Background()

	models, err := fetchModels(ctx, client, baseURL, modelsPath, apiKey)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fetch models failed: %v\n", err)
		os.Exit(1)
	}
	models = filterModels(models, includeRE, excludeRE)
	if limit > 0 && len(models) > limit {
		models = models[:limit]
	}
	if len(models) == 0 {
		fmt.Fprintln(os.Stderr, "no models available after filtering")
		os.Exit(1)
	}

	fmt.Printf("Models discovered: %d\n", len(models))
	if listOnly {
		for _, modelID := range models {
			fmt.Println(modelID)
		}
		return
	}
	fmt.Printf("Mode=%s, requests/model=%d, concurrency=%d, timeout=%s\n", runMode, requestsPerModel, concurrency, timeout)

	jobs := make(chan job)
	results := make(chan runResult, max(64, concurrency*2))
	var wg sync.WaitGroup
	for workerID := 0; workerID < concurrency; workerID++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				res := runSingleProbe(ctx, client, baseURL, apiKey, runMode, chatPath, responsesPath, j.Model, prompt, maxTokens, temperature, j.Attempt)
				results <- res
				if pause > 0 {
					time.Sleep(pause)
				}
			}
		}()
	}

	go func() {
		for _, modelID := range models {
			for attempt := 1; attempt <= requestsPerModel; attempt++ {
				jobs <- job{Model: modelID, Attempt: attempt}
			}
		}
		close(jobs)
		wg.Wait()
		close(results)
	}()

	statsByModel := make(map[string]*modelStats, len(models))
	totalJobs := len(models) * requestsPerModel
	doneJobs := 0
	started := time.Now()

	for res := range results {
		doneJobs++
		stats := statsByModel[res.Model]
		if stats == nil {
			stats = &modelStats{
				ClassCounts: make(map[string]int),
				Statuses:    make(map[int]int),
			}
			statsByModel[res.Model] = stats
		}
		stats.Total++
		stats.Durations = append(stats.Durations, res.Duration)
		if res.Status > 0 {
			stats.Statuses[res.Status]++
		}
		if res.Success {
			stats.Success++
		} else {
			stats.Failures++
			stats.ClassCounts[res.Class]++
		}
		if res.RetryAfter > 0 {
			stats.RetryAfter = append(stats.RetryAfter, res.RetryAfter)
		}

		if doneJobs%max(1, totalJobs/10) == 0 || doneJobs == totalJobs {
			fmt.Printf("Progress: %d/%d completed\n", doneJobs, totalJobs)
		}
	}

	renderSummary(statsByModel, models, started)
	if jsonOut != "" {
		if errWrite := writeJSONSummary(jsonOut, baseURL, runMode, requestsPerModel, concurrency, statsByModel, models, started); errWrite != nil {
			fmt.Fprintf(os.Stderr, "write json summary failed: %v\n", errWrite)
			os.Exit(1)
		}
		fmt.Printf("JSON summary written: %s\n", jsonOut)
	}
}

func runSingleProbe(
	ctx context.Context,
	client *http.Client,
	baseURL, apiKey string,
	runMode mode,
	chatPath, responsesPath, modelID, prompt string,
	maxTokens int,
	temperature float64,
	attempt int,
) runResult {
	switch runMode {
	case modeChat:
		return executeChat(ctx, client, baseURL, apiKey, chatPath, modelID, prompt, maxTokens, temperature, attempt)
	case modeResponses:
		return executeResponses(ctx, client, baseURL, apiKey, responsesPath, modelID, prompt, maxTokens, temperature, attempt)
	default:
		first := executeChat(ctx, client, baseURL, apiKey, chatPath, modelID, prompt, maxTokens, temperature, attempt)
		if first.Success {
			return first
		}
		if shouldFallbackToResponses(first.Status, first.RawBodyShort, first.Class) {
			second := executeResponses(ctx, client, baseURL, apiKey, responsesPath, modelID, prompt, maxTokens, temperature, attempt)
			if second.Success || second.Class != classUnsupported {
				return second
			}
		}
		return first
	}
}

func executeChat(ctx context.Context, client *http.Client, baseURL, apiKey, path, modelID, prompt string, maxTokens int, temperature float64, attempt int) runResult {
	payload := map[string]any{
		"model":       modelID,
		"stream":      false,
		"max_tokens":  maxTokens,
		"temperature": temperature,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
	}
	return executeRequest(ctx, client, baseURL+path, apiKey, payload, "chat", modelID, attempt)
}

func executeResponses(ctx context.Context, client *http.Client, baseURL, apiKey, path, modelID, prompt string, maxTokens int, temperature float64, attempt int) runResult {
	payload := map[string]any{
		"model":             modelID,
		"stream":            false,
		"max_output_tokens": maxTokens,
		"temperature":       temperature,
		"input":             prompt,
	}
	return executeRequest(ctx, client, baseURL+path, apiKey, payload, "responses", modelID, attempt)
}

func executeRequest(ctx context.Context, client *http.Client, url, apiKey string, payload map[string]any, modeName, modelID string, attempt int) runResult {
	out := runResult{
		Model:    modelID,
		ModeUsed: modeName,
		Attempt:  attempt,
	}
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		out.Class = classOther
		out.ErrMessage = "marshal payload: " + err.Error()
		return out
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(rawPayload))
	if err != nil {
		out.Class = classOther
		out.ErrMessage = "build request: " + err.Error()
		return out
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	start := time.Now()
	resp, err := client.Do(req)
	out.Duration = time.Since(start)
	if err != nil {
		out.Class = classTransient
		out.ErrMessage = err.Error()
		return out
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	out.Status = resp.StatusCode
	out.RawBodyShort = string(body)
	if len(out.RawBodyShort) > 400 {
		out.RawBodyShort = out.RawBodyShort[:400]
	}

	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		if embeddedClass, embeddedRetryAfter, ok := classifyEmbeddedProviderError(resp.Header, body); ok {
			out.Class = embeddedClass
			out.RetryAfter = embeddedRetryAfter
			out.ErrMessage = strings.TrimSpace(string(body))
			return out
		}
		out.Success = true
		return out
	}

	class, retryAfter := classifyFailure(resp.StatusCode, resp.Header, body)
	out.Class = class
	out.RetryAfter = retryAfter
	out.ErrMessage = strings.TrimSpace(string(body))
	return out
}

func shouldFallbackToResponses(status int, body string, class string) bool {
	if class == classUnsupported {
		return true
	}
	if status != http.StatusBadRequest && status != http.StatusNotFound && status != http.StatusUnprocessableEntity && status != http.StatusNotImplemented {
		return false
	}
	lower := normalizeText(body)
	markers := []string{
		"/chat/completions",
		"responses",
		"streaming not supported",
		"not implemented",
		"model not supported",
		"unsupported model",
	}
	return containsAny(lower, markers)
}

func fetchModels(ctx context.Context, client *http.Client, baseURL, modelsPath, apiKey string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+modelsPath, nil)
	if err != nil {
		return nil, err
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("models endpoint returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var parsed modelListResponse
	if errUnmarshal := json.Unmarshal(body, &parsed); errUnmarshal != nil {
		return nil, fmt.Errorf("decode models response: %w", errUnmarshal)
	}
	models := make([]string, 0, len(parsed.Data))
	seen := make(map[string]struct{}, len(parsed.Data))
	for _, item := range parsed.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		models = append(models, id)
	}
	sort.Strings(models)
	return models, nil
}

func classifyFailure(status int, headers http.Header, body []byte) (string, time.Duration) {
	text := normalizeText(string(body))
	retryAfter := parseRetryAfter(headers.Get("Retry-After"), text)

	blockedMarkers := []string{
		"account blocked",
		"account is blocked",
		"has been blocked due to unauthorized requests",
		"blocked due to unauthorized requests",
		"account suspended",
		"account is suspended",
		"account banned",
		"policy violation",
		"api key revoked",
		"api key disabled",
		"access revoked",
		"token revoked",
	}
	cooldownMarkers := []string{
		"cooldown",
		"retry after",
		"try again in",
		"reset after",
		"available in",
		"wait for",
	}
	quotaMarkers := []string{
		"insufficient quota",
		"quota exceeded",
		"quota exhausted",
		"resource exhausted",
		"rate limit",
		"too many requests",
	}
	unsupportedMarkers := []string{
		"unsupported model",
		"model is not supported",
		"requested model is not supported",
		"model not support",
		"not implemented",
		"unprocessable entity",
	}

	if containsAny(text, blockedMarkers) {
		return classBlocked, retryAfter
	}

	switch status {
	case http.StatusUnauthorized:
		return classUnauthorized, retryAfter
	case http.StatusTooManyRequests:
		if retryAfter > 0 || containsAny(text, cooldownMarkers) {
			return classCooldown, retryAfter
		}
		return classQuota, retryAfter
	case http.StatusForbidden, http.StatusPaymentRequired:
		if containsAny(text, quotaMarkers) {
			if retryAfter > 0 || containsAny(text, cooldownMarkers) {
				return classCooldown, retryAfter
			}
			return classQuota, retryAfter
		}
		return classUnauthorized, retryAfter
	case http.StatusRequestTimeout, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return classTransient, retryAfter
	case http.StatusBadRequest, http.StatusUnprocessableEntity, http.StatusNotFound, http.StatusNotImplemented:
		if containsAny(text, unsupportedMarkers) {
			return classUnsupported, retryAfter
		}
	}
	if containsAny(text, unsupportedMarkers) {
		return classUnsupported, retryAfter
	}

	if retryAfter > 0 || containsAny(text, cooldownMarkers) {
		return classCooldown, retryAfter
	}
	if containsAny(text, quotaMarkers) {
		return classQuota, retryAfter
	}
	if status >= 500 {
		return classTransient, retryAfter
	}
	return classOther, retryAfter
}

func classifyEmbeddedProviderError(headers http.Header, body []byte) (string, time.Duration, bool) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || (trimmed[0] != '{' && trimmed[0] != '[') {
		return "", 0, false
	}

	var payload any
	if err := json.Unmarshal(trimmed, &payload); err != nil {
		return "", 0, false
	}

	text := normalizeText(string(trimmed))
	hasErrorObject := extractJSONValue(payload, "error") != nil
	if hasErrorObject {
		embeddedStatus := parseEmbeddedStatusCode(payload)
		if embeddedStatus == 0 {
			embeddedStatus = mapEmbeddedStatusFromText(text)
			if embeddedStatus == 0 {
				embeddedStatus = http.StatusBadGateway
			}
		}
		class, retryAfter := classifyFailure(embeddedStatus, headers, trimmed)
		return class, retryAfter, true
	}

	embeddedStatus := parseEmbeddedStatusCode(payload)
	if embeddedStatus >= 400 {
		class, retryAfter := classifyFailure(embeddedStatus, headers, trimmed)
		return class, retryAfter, true
	}

	markers := []string{
		"blocked",
		"suspended",
		"banned",
		"revoked",
		"unauthorized",
		"invalid api key",
		"cooldown",
		"retry after",
		"try again in",
		"quota",
		"rate limit",
		"too many requests",
		"resource exhausted",
		"degraded function",
	}
	if !containsAny(text, markers) {
		return "", 0, false
	}

	embeddedStatus = mapEmbeddedStatusFromText(text)
	if embeddedStatus == 0 {
		embeddedStatus = http.StatusBadGateway
	}
	class, retryAfter := classifyFailure(embeddedStatus, headers, trimmed)
	return class, retryAfter, true
}

func parseEmbeddedStatusCode(payload any) int {
	paths := [][]string{
		{"status"},
		{"status_code"},
		{"error", "status"},
		{"error", "status_code"},
	}
	for _, path := range paths {
		value := extractJSONValue(payload, path...)
		if value == nil {
			continue
		}
		switch typed := value.(type) {
		case float64:
			code := int(typed)
			if code > 0 {
				return code
			}
		case string:
			code, err := strconv.Atoi(strings.TrimSpace(typed))
			if err == nil && code > 0 {
				return code
			}
		}
	}
	return 0
}

func extractJSONValue(root any, path ...string) any {
	current := root
	for _, key := range path {
		node, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		next, exists := node[key]
		if !exists {
			return nil
		}
		current = next
	}
	return current
}

func mapEmbeddedStatusFromText(text string) int {
	if containsAny(text, []string{"blocked", "suspended", "banned", "revoked", "disabled"}) {
		return http.StatusForbidden
	}
	if containsAny(text, []string{"unauthorized", "invalid api key", "authentication", "forbidden"}) {
		return http.StatusUnauthorized
	}
	if containsAny(text, []string{"cooldown", "retry after", "try again in", "quota", "rate limit", "too many requests", "resource exhausted"}) {
		return http.StatusTooManyRequests
	}
	return 0
}

func parseRetryAfter(headerValue string, text string) time.Duration {
	headerValue = strings.TrimSpace(headerValue)
	if headerValue != "" {
		if seconds, err := strconv.Atoi(headerValue); err == nil && seconds > 0 {
			return time.Duration(seconds) * time.Second
		}
		if when, err := http.ParseTime(headerValue); err == nil {
			wait := time.Until(when)
			if wait > 0 {
				return wait
			}
		}
	}
	if duration := parseRetryAfterText(text); duration > 0 {
		return duration
	}
	return 0
}

func parseRetryAfterText(text string) time.Duration {
	parseNumber := func(raw string) float64 {
		value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		if err != nil || value <= 0 {
			return 0
		}
		return value
	}
	parseUnit := func(raw string) time.Duration {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "ms", "millisecond", "milliseconds":
			return time.Millisecond
		case "s", "sec", "secs", "second", "seconds":
			return time.Second
		case "m", "min", "mins", "minute", "minutes":
			return time.Minute
		case "h", "hr", "hrs", "hour", "hours":
			return time.Hour
		default:
			return 0
		}
	}

	matches := retryAfterTextPattern.FindStringSubmatch(text)
	if len(matches) == 3 {
		value := parseNumber(matches[1])
		unit := parseUnit(matches[2])
		if value > 0 && unit > 0 {
			return time.Duration(value * float64(unit))
		}
	}
	matches = retryAfterPlainPattern.FindStringSubmatch(text)
	if len(matches) == 2 {
		value := parseNumber(matches[1])
		if value > 0 {
			return time.Duration(value * float64(time.Second))
		}
	}
	return 0
}

func renderSummary(statsByModel map[string]*modelStats, modelOrder []string, started time.Time) {
	w := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	fmt.Fprintln(w, "MODEL\tTOTAL\tOK\tFAIL\tBLOCKED\tCOOLDOWN\t401\tQUOTA\tTRANSIENT\tUNSUPPORTED\tOTHER\tAVG_MS\tP95_MS")

	var overall modelStats
	for _, modelID := range modelOrder {
		stats := statsByModel[modelID]
		if stats == nil {
			stats = &modelStats{ClassCounts: make(map[string]int), Statuses: make(map[int]int)}
		}
		avgMs := avgDurationMs(stats.Durations)
		p95Ms := percentileDurationMs(stats.Durations, 95)

		fmt.Fprintf(w, "%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\n",
			modelID,
			stats.Total,
			stats.Success,
			stats.Failures,
			stats.ClassCounts[classBlocked],
			stats.ClassCounts[classCooldown],
			stats.ClassCounts[classUnauthorized],
			stats.ClassCounts[classQuota],
			stats.ClassCounts[classTransient],
			stats.ClassCounts[classUnsupported],
			stats.ClassCounts[classOther],
			avgMs,
			p95Ms,
		)

		overall.Total += stats.Total
		overall.Success += stats.Success
		overall.Failures += stats.Failures
		if overall.ClassCounts == nil {
			overall.ClassCounts = make(map[string]int)
		}
		for key, value := range stats.ClassCounts {
			overall.ClassCounts[key] += value
		}
		overall.Durations = append(overall.Durations, stats.Durations...)
	}
	_ = w.Flush()

	fmt.Println()
	fmt.Printf("Completed in %s\n", time.Since(started).Round(time.Millisecond))
	fmt.Printf("Overall: total=%d ok=%d fail=%d blocked=%d cooldown=%d unauthorized=%d quota=%d transient=%d unsupported=%d other=%d avg_ms=%d p95_ms=%d\n",
		overall.Total,
		overall.Success,
		overall.Failures,
		overall.ClassCounts[classBlocked],
		overall.ClassCounts[classCooldown],
		overall.ClassCounts[classUnauthorized],
		overall.ClassCounts[classQuota],
		overall.ClassCounts[classTransient],
		overall.ClassCounts[classUnsupported],
		overall.ClassCounts[classOther],
		avgDurationMs(overall.Durations),
		percentileDurationMs(overall.Durations, 95),
	)
}

func writeJSONSummary(path string, baseURL string, runMode mode, requestsPerModel int, concurrency int, statsByModel map[string]*modelStats, modelOrder []string, started time.Time) error {
	type jsonModel struct {
		Model      string         `json:"model"`
		Total      int            `json:"total"`
		Success    int            `json:"success"`
		Failures   int            `json:"failures"`
		ClassCount map[string]int `json:"class_count"`
		Statuses   map[int]int    `json:"statuses"`
		AvgMs      int            `json:"avg_ms"`
		P95Ms      int            `json:"p95_ms"`
	}
	outModels := make([]jsonModel, 0, len(modelOrder))
	for _, modelID := range modelOrder {
		stats := statsByModel[modelID]
		if stats == nil {
			continue
		}
		outModels = append(outModels, jsonModel{
			Model:      modelID,
			Total:      stats.Total,
			Success:    stats.Success,
			Failures:   stats.Failures,
			ClassCount: stats.ClassCounts,
			Statuses:   stats.Statuses,
			AvgMs:      avgDurationMs(stats.Durations),
			P95Ms:      percentileDurationMs(stats.Durations, 95),
		})
	}

	payload := map[string]any{
		"base_url":            baseURL,
		"mode":                runMode,
		"requests_per_model":  requestsPerModel,
		"concurrency":         concurrency,
		"started_at":          started.UTC().Format(time.RFC3339),
		"finished_at":         time.Now().UTC().Format(time.RFC3339),
		"duration_ms":         time.Since(started).Milliseconds(),
		"models_tested_count": len(outModels),
		"models":              outModels,
	}
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o644)
}

func avgDurationMs(values []time.Duration) int {
	if len(values) == 0 {
		return 0
	}
	var total time.Duration
	for _, value := range values {
		total += value
	}
	return int(total.Milliseconds() / int64(len(values)))
}

func percentileDurationMs(values []time.Duration, p int) int {
	if len(values) == 0 {
		return 0
	}
	if p < 1 {
		p = 1
	}
	if p > 100 {
		p = 100
	}
	cloned := append([]time.Duration(nil), values...)
	sort.Slice(cloned, func(i, j int) bool { return cloned[i] < cloned[j] })
	pos := int(math.Ceil(float64(p)/100*float64(len(cloned)))) - 1
	if pos < 0 {
		pos = 0
	}
	if pos >= len(cloned) {
		pos = len(cloned) - 1
	}
	return int(cloned[pos].Milliseconds())
}

func compileOptionalRegex(pattern string) (*regexp.Regexp, error) {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return nil, nil
	}
	return regexp.Compile(pattern)
}

func filterModels(models []string, includeRE, excludeRE *regexp.Regexp) []string {
	out := make([]string, 0, len(models))
	for _, modelID := range models {
		if includeRE != nil && !includeRE.MatchString(modelID) {
			continue
		}
		if excludeRE != nil && excludeRE.MatchString(modelID) {
			continue
		}
		out = append(out, modelID)
	}
	return out
}

func normalizeText(text string) string {
	text = strings.ToLower(text)
	text = strings.ReplaceAll(text, "_", " ")
	text = strings.ReplaceAll(text, "-", " ")
	return strings.Join(strings.Fields(text), " ")
}

func containsAny(text string, parts []string) bool {
	if text == "" {
		return false
	}
	for _, part := range parts {
		if part != "" && strings.Contains(text, part) {
			return true
		}
	}
	return false
}

func firstNonEmptyEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
