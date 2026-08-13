package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	log "github.com/sirupsen/logrus"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// isBatchModel returns true if the model name has a ":batch" or "-batch" suffix.
func isBatchModel(model string) bool {
	return strings.HasSuffix(model, ":batch") || strings.HasSuffix(model, "-batch")
}

// trimBatchSuffix removes the ":batch" or "-batch" suffix.
func trimBatchSuffix(model string) string {
	if strings.HasSuffix(model, ":batch") {
		return strings.TrimSuffix(model, ":batch")
	}
	return strings.TrimSuffix(model, "-batch")
}

// Batch config defaults.
const (
	batchMaxWait        = 10 * time.Minute
	batchInitialPoll    = 2 * time.Second
	batchMaxPoll        = 15 * time.Second
	batchPollBackoff    = 1.5
	batchPollJitter     = 0.2
)

// batchCreateRequest is the body for POST /api/beta/batches.
type batchCreateRequest struct {
	Endpoint  string                `json:"endpoint"`
	Model     string                `json:"model"`
	Requests  []batchRequestItem    `json:"requests"`
}

type batchRequestItem struct {
	CustomID string          `json:"custom_id"`
	Method   string          `json:"method"`
	URL      string          `json:"url"`
	Body     json.RawMessage `json:"body"`
}

// batchResponse is the response from creating or polling a batch.
type batchResponse struct {
	ID           string          `json:"id"`
	Status       string          `json:"status"`
	RequestCounts struct {
		Total     int             `json:"total"`
		Completed int             `json:"completed"`
		Failed    int             `json:"failed"`
	} `json:"request_counts"`
	Results json.RawMessage `json:"results"`
}

// executeBatch submits a one-item batch to OpenRouter, polls it, and returns
// the completed chat completion body. Returns the original `results` for
// translation by the caller.
func (e *OpenAICompatExecutor) executeBatch(
	ctx context.Context,
	auth *cliproxyauth.Auth,
	baseURL, apiKey string,
	model string,
	translated []byte,
) ([]byte, error) {
	customID := fmt.Sprintf("cpa-batch-%d", time.Now().UnixNano())
	// Use the upstream model name from the translated payload (after alias resolution).
	// If not present, fall back to the executor's baseModel.
	batchModel := model
	if m := gjson.GetBytes(translated, "model").String(); m != "" {
		batchModel = m
	}

	// Inner request body: strip ":batch" if same model would be rejected.
	// OpenRouter Batch API accepts the original model in the inner body.
	innerBody := translated
	// Remove "stream" from inner body if present
	if updated, errDel := sjson.DeleteBytes(innerBody, "stream"); errDel == nil {
		innerBody = updated
	}

	createReq := batchCreateRequest{
		Endpoint: "/v1/chat/completions",
		Model:    batchModel,
		Requests: []batchRequestItem{
			{
				CustomID: customID,
				Method:   "POST",
				URL:      "/v1/chat/completions",
				Body:     innerBody,
			},
		},
	}
	createBody, err := json.Marshal(createReq)
	if err != nil {
		return nil, fmt.Errorf("batch: marshal create request: %w", err)
	}

	// POST /api/beta/batches — baseURL is like "https://openrouter.ai/api/v1",
	// but batch endpoint is at "https://openrouter.ai/api/beta/batches".
	// Strip trailing slash and "/v1" suffix to get the API root (e.g. "https://openrouter.ai/api").
	rootURL := strings.TrimSuffix(baseURL, "/")
	rootURL = strings.TrimSuffix(rootURL, "/v1")
	rootURL = strings.TrimSuffix(rootURL, "/")
	batchURL := rootURL + "/beta/batches"
	log.Infof("batch: baseURL=%s rootURL=%s batchURL=%s", baseURL, rootURL, batchURL)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, batchURL, bytes.NewReader(createBody))
	if err != nil {
		return nil, fmt.Errorf("batch: create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	}

	batchHTTPClient := helps.NewProxyAwareHTTPClient(ctx, e.cfg, auth, 30*time.Second)
	resp, err := batchHTTPClient.Do(httpReq)
	if err != nil {
			return nil, fmt.Errorf("batch: create request failed: %w", err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	log.Infof("batch: create POST returned status=%d", resp.StatusCode)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("batch: create request returned %d: %s", resp.StatusCode, string(respBody))
	}

	var batch batchResponse
	if err := json.Unmarshal(respBody, &batch); err != nil {
		return nil, fmt.Errorf("batch: unmarshal create response: %w", err)
	}
	if batch.ID == "" {
		return nil, fmt.Errorf("batch: no batch ID returned: %s", string(respBody))
	}
	log.WithField("batch_id", batch.ID).Info("openai compat executor: batch submitted")

	// Poll
	deadline := time.Now().Add(batchMaxWait)
	pollInterval := batchInitialPoll

	for {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("batch: request did not complete within %v", batchMaxWait)
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(pollInterval):
		}

		// GET /api/beta/batches/{id}
		pollURL := rootURL + "/beta/batches/" + batch.ID
		pollReq, err := http.NewRequestWithContext(ctx, http.MethodGet, pollURL, nil)
		if err != nil {
			return nil, fmt.Errorf("batch: poll request: %w", err)
		}
		if apiKey != "" {
			pollReq.Header.Set("Authorization", "Bearer "+apiKey)
		}

		pollResp, err := batchHTTPClient.Do(pollReq)
		if err != nil {
				pollInterval = nextBatchPollInterval(pollInterval)
			continue
		}
		pollBody, _ := io.ReadAll(pollResp.Body)
		pollResp.Body.Close()

		if pollResp.StatusCode < 200 || pollResp.StatusCode >= 300 {
			log.WithField("status", pollResp.StatusCode).Warn("openai compat executor: batch poll returned error")
			pollInterval = nextBatchPollInterval(pollInterval)
			continue
		}

		var current batchResponse
		if err := json.Unmarshal(pollBody, &current); err != nil {
			log.WithError(err).Warn("openai compat executor: batch poll unmarshal failed")
			pollInterval = nextBatchPollInterval(pollInterval)
			continue
		}

		log.WithFields(log.Fields{
			"batch_id": batch.ID,
			"status":    current.Status,
			"completed": current.RequestCounts.Completed,
			"failed":    current.RequestCounts.Failed,
		}).Debug("openai compat executor: batch poll")

		switch current.Status {
		case "validating", "in_progress":
			pollInterval = nextBatchPollInterval(pollInterval)
			continue

		case "completed":
			// Extract the result matching custom_id.
			results := gjson.GetBytes(pollBody, "results")
			if !results.IsArray() {
				return nil, fmt.Errorf("batch: completed but results is not an array")
			}
			var foundBody json.RawMessage
			for _, r := range results.Array() {
				if r.Get("custom_id").String() == customID {
					foundBody = json.RawMessage(r.Get("response.body").Raw)
					break
				}
			}
			if foundBody == nil {
				return nil, fmt.Errorf("batch: completed but no result with custom_id %q found", customID)
			}
			log.WithField("batch_id", batch.ID).Info("openai compat executor: batch completed")
			return foundBody, nil

		case "failed", "expired", "cancelled":
			return nil, fmt.Errorf("batch: status %s: %s", current.Status, string(pollBody))

		default:
			pollInterval = nextBatchPollInterval(pollInterval)
			continue
		}
	}
}

func nextBatchPollInterval(current time.Duration) time.Duration {
	next := time.Duration(float64(current) * batchPollBackoff)
	if next > batchMaxPoll {
		next = batchMaxPoll
	}
	if batchPollJitter > 0 {
		jitter := time.Duration(rand.Float64() * batchPollJitter * float64(next))
		next += jitter
	}
	return next
}

// Helpers for Execute and ExecuteStream to use batch when model has :batch suffix.

// shouldUseBatch returns true if the batch flow should be used for this model + options.
func shouldUseBatch(model string, opts cliproxyexecutor.Options) bool {
	if !isBatchModel(model) {
		return false
	}
	// Don't use batch for image/passthrough/responses endpoints.
	if opts.Alt != "" {
		return false
	}
	return true
}
