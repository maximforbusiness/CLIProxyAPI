package executor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	log "github.com/sirupsen/logrus"
)

// OllamaExecutor implements a stateless executor for Ollama API endpoints.
type OllamaExecutor struct {
	cfg *config.Config
}

// NewOllamaExecutor creates a new Ollama executor.
func NewOllamaExecutor(cfg *config.Config) *OllamaExecutor {
	return &OllamaExecutor{cfg: cfg}
}

// Identifier implements cliproxyauth.ProviderExecutor.
func (e *OllamaExecutor) Identifier() string { return "ollama" }

// Execute handles non-streaming requests to Ollama endpoints.
func (e *OllamaExecutor) Execute(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	baseURL, apiKey, err := e.resolveCredentials(auth)
	if err != nil {
		return cliproxyexecutor.Response{}, statusErr{code: http.StatusUnauthorized, msg: err.Error()}
	}

	payload := req.Payload
	if len(payload) == 0 {
		return cliproxyexecutor.Response{}, statusErr{code: http.StatusBadRequest, msg: "missing request body"}
	}

	url := strings.TrimSuffix(baseURL, "/") + "/api/web_search"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return cliproxyexecutor.Response{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	}
	httpReq.Header.Set("User-Agent", "cli-proxy-ollama")

	var authID, authLabel, authType, authValue string
	if auth != nil {
		authID = auth.ID
		authLabel = auth.Label
		authType, authValue = auth.AccountInfo()
	}
	helps.RecordAPIRequest(ctx, e.cfg, helps.UpstreamRequestLog{
		URL:       url,
		Method:    http.MethodPost,
		Headers:   httpReq.Header.Clone(),
		Body:      payload,
		Provider:  e.Identifier(),
		AuthID:    authID,
		AuthLabel: authLabel,
		AuthType:  authType,
		AuthValue: authValue,
	})

	httpClient := helps.NewProxyAwareHTTPClient(ctx, e.cfg, auth, 0)
	httpResp, err := httpClient.Do(httpReq)
	if err != nil {
		helps.RecordAPIResponseError(ctx, e.cfg, err)
		return cliproxyexecutor.Response{}, err
	}
	defer func() {
		if errClose := httpResp.Body.Close(); errClose != nil {
			log.Errorf("ollama executor: close response body error: %v", errClose)
		}
	}()
	helps.RecordAPIResponseMetadata(ctx, e.cfg, httpResp.StatusCode, httpResp.Header.Clone())

	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		b, _ := io.ReadAll(httpResp.Body)
		helps.AppendAPIResponseChunk(ctx, e.cfg, b)
		helps.LogWithRequestID(ctx).Debugf("ollama executor: upstream error status: %d, message: %s", httpResp.StatusCode, helps.SummarizeErrorBody(httpResp.Header.Get("Content-Type"), b))
		return cliproxyexecutor.Response{}, statusErr{code: httpResp.StatusCode, msg: string(b)}
	}

	body, err := io.ReadAll(httpResp.Body)
	if err != nil {
		helps.RecordAPIResponseError(ctx, e.cfg, err)
		return cliproxyexecutor.Response{}, err
	}
	helps.AppendAPIResponseChunk(ctx, e.cfg, body)

	return cliproxyexecutor.Response{Payload: body, Headers: httpResp.Header.Clone()}, nil
}

// ExecuteStream is not supported for Ollama web search (non-streaming API).
func (e *OllamaExecutor) ExecuteStream(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	return nil, statusErr{code: http.StatusBadRequest, msg: "ollama web search does not support streaming"}
}

// Refresh is a no-op for API-key based providers.
func (e *OllamaExecutor) Refresh(ctx context.Context, auth *cliproxyauth.Auth) (*cliproxyauth.Auth, error) {
	_ = ctx
	return auth, nil
}

// CountTokens is not applicable for Ollama web search.
func (e *OllamaExecutor) CountTokens(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, statusErr{code: http.StatusNotImplemented, msg: "token counting not supported for ollama web search"}
}

// HttpRequest implements RequestPreparer - injects credentials into the outgoing HTTP request.
func (e *OllamaExecutor) HttpRequest(ctx context.Context, auth *cliproxyauth.Auth, req *http.Request) (*http.Response, error) {
	if req == nil {
		return nil, fmt.Errorf("ollama executor: request is nil")
	}
	_, apiKey, err := e.resolveCredentials(auth)
	if err != nil {
		return nil, err
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	httpClient := helps.NewProxyAwareHTTPClient(ctx, e.cfg, auth, 0)
	return httpClient.Do(req)
}

// resolveCredentials extracts base URL and API key from auth config.
func (e *OllamaExecutor) resolveCredentials(auth *cliproxyauth.Auth) (baseURL, apiKey string, err error) {
	// First try to resolve from config OpenAICompatibility list using auth attributes
	if e.cfg != nil && auth != nil {
		providerKey := ""
		compatName := ""
		if auth.Attributes != nil {
			providerKey = strings.TrimSpace(auth.Attributes["provider_key"])
			compatName = strings.TrimSpace(auth.Attributes["compat_name"])
			if apiKeyAttr := strings.TrimSpace(auth.Attributes["api_key"]); apiKeyAttr != "" {
				apiKey = apiKeyAttr
			}
			if baseURLAttr := strings.TrimSpace(auth.Attributes["base_url"]); baseURLAttr != "" {
				baseURL = baseURLAttr
			}
		}
		// If baseURL not set via attributes, try to find matching OpenAICompatibility entry
		if baseURL == "" && e.cfg.OpenAICompatibility != nil {
			entry := resolveOllamaCompatEntry(e.cfg, providerKey, compatName, auth.Provider)
			if entry != nil {
				baseURL = strings.TrimSpace(entry.BaseURL)
			}
		}
		// If apiKey not set via attributes, try to find matching key in config
		if apiKey == "" && e.cfg.OpenAICompatibility != nil {
			if entry := resolveOllamaCompatEntry(e.cfg, providerKey, compatName, auth.Provider); entry != nil {
				apiKey = resolveOllamaAPIKey(entry, auth)
			}
		}
	}
	if baseURL == "" {
		return "", "", fmt.Errorf("missing ollama base URL")
	}
	return baseURL, apiKey, nil
}

// resolveOllamaCompatEntry finds OpenAICompatibility entry matching the auth.
func resolveOllamaCompatEntry(cfg *config.Config, providerKey, compatName, authProvider string) *config.OpenAICompatibility {
	if cfg == nil {
		return nil
	}
	candidates := make([]string, 0, 4)
	if v := strings.TrimSpace(compatName); v != "" {
		candidates = append(candidates, v)
	}
	if v := strings.TrimSpace(providerKey); v != "" {
		candidates = append(candidates, v)
	}
	if v := strings.TrimSpace(authProvider); v != "" {
		candidates = append(candidates, v)
	}
	for i := range cfg.OpenAICompatibility {
		compat := &cfg.OpenAICompatibility[i]
		for _, candidate := range candidates {
			if candidate != "" && strings.EqualFold(strings.TrimSpace(candidate), compat.Name) {
				return compat
			}
		}
	}
	return nil
}

// resolveOllamaAPIKey finds the API key from the OpenAICompatibility entry that matches the auth.
func resolveOllamaAPIKey(entry *config.OpenAICompatibility, auth *cliproxyauth.Auth) string {
	if entry == nil || auth == nil {
		return ""
	}
	var attrKey string
	if auth.Attributes != nil {
		attrKey = strings.TrimSpace(auth.Attributes["api_key"])
	}
	for i := range entry.APIKeyEntries {
		cfgEntry := &entry.APIKeyEntries[i]
		cfgKey := strings.TrimSpace(cfgEntry.APIKey)
		if attrKey != "" && strings.EqualFold(cfgKey, attrKey) {
			return cfgKey
		}
	}
	// Fallback: if no attribute match, use first non-empty key
	if attrKey == "" {
		for i := range entry.APIKeyEntries {
			key := strings.TrimSpace(entry.APIKeyEntries[i].APIKey)
			if key != "" {
				return key
			}
		}
	}
	return ""
}