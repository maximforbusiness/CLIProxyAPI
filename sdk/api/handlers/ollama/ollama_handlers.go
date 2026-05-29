package ollama

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/api/handlers"
)

var ollamaKeyRR atomic.Uint64

// OllamaAPIHandler contains the handlers for Ollama API endpoints.
type OllamaAPIHandler struct {
	*handlers.BaseAPIHandler
}

// NewOllamaAPIHandler creates a new Ollama API handlers instance.
func NewOllamaAPIHandler(apiHandlers *handlers.BaseAPIHandler) *OllamaAPIHandler {
	return &OllamaAPIHandler{BaseAPIHandler: apiHandlers}
}

// HandlerType returns the type identifier for this handler.
func (h *OllamaAPIHandler) HandlerType() string {
	return "ollama"
}

// Models returns the list of models supported by this handler.
func (h *OllamaAPIHandler) Models() []map[string]any {
	return nil
}

// WebSearch handles /ollama/api/web_search.
func (h *OllamaAPIHandler) WebSearch(c *gin.Context) {
	h.proxyOllamaEndpoint(c, "/api/web_search")
}

// WebFetch handles /ollama/api/web_fetch.
func (h *OllamaAPIHandler) WebFetch(c *gin.Context) {
	h.proxyOllamaEndpoint(c, "/api/web_fetch")
}

func (h *OllamaAPIHandler) proxyOllamaEndpoint(c *gin.Context, upstreamPath string) {
	rawJSON, err := c.GetRawData()
	if err != nil {
		body := handlers.BuildErrorResponseBody(400, "invalid request: "+err.Error())
		c.Header("Content-Type", "application/json")
		c.Writer.WriteHeader(400)
		_, _ = c.Writer.Write(body)
		return
	}

	cfg := h.AuthManager.RuntimeConfig()
	if cfg == nil {
		body := handlers.BuildErrorResponseBody(500, "config not available")
		c.Header("Content-Type", "application/json")
		c.Writer.WriteHeader(500)
		_, _ = c.Writer.Write(body)
		return
	}

	keys := make([]string, 0, 8)
	for i := range cfg.OpenAICompatibility {
		compat := &cfg.OpenAICompatibility[i]
		if compat.Name == "Ollama" || compat.Name == "ollama" {
			for j := range compat.APIKeyEntries {
				key := strings.TrimSpace(compat.APIKeyEntries[j].APIKey)
				if key != "" {
					keys = append(keys, key)
				}
			}
			break
		}
	}
	if len(keys) == 0 {
		body := handlers.BuildErrorResponseBody(401, "ollama API key not configured")
		c.Header("Content-Type", "application/json")
		c.Writer.WriteHeader(401)
		_, _ = c.Writer.Write(body)
		return
	}

	upstreamURL := "https://ollama.com" + upstreamPath
	httpClient := &http.Client{Timeout: 60 * time.Second}
	start := int(ollamaKeyRR.Add(1)-1) % len(keys)

	var lastStatus int
	var lastBody []byte
	lastHeaders := make(http.Header)

	for attempt := 0; attempt < len(keys); attempt++ {
		key := keys[(start+attempt)%len(keys)]
		req, errReq := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, upstreamURL, bytes.NewReader(rawJSON))
		if errReq != nil {
			body := handlers.BuildErrorResponseBody(400, "failed to build request: "+errReq.Error())
			c.Header("Content-Type", "application/json")
			c.Writer.WriteHeader(400)
			_, _ = c.Writer.Write(body)
			return
		}
		for hKey, values := range c.Request.Header {
			for _, value := range values {
				if !strings.EqualFold(hKey, "Authorization") {
					req.Header.Set(hKey, value)
				}
			}
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("User-Agent", "cli-proxy-ollama")

		resp, errDo := httpClient.Do(req)
		if errDo != nil {
			lastStatus = http.StatusBadGateway
			lastBody = []byte("{\"error\":\"upstream request failed\"}")
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		lastStatus = resp.StatusCode
		lastBody = body
		lastHeaders = resp.Header.Clone()

		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
			continue
		}

		for hKey, values := range lastHeaders {
			for _, value := range values {
				c.Header(hKey, value)
			}
		}
		c.Header("Content-Type", "application/json")
		c.Writer.WriteHeader(lastStatus)
		_, _ = c.Writer.Write(lastBody)
		return
	}

	if lastStatus == 0 {
		lastStatus = http.StatusBadGateway
		lastBody = handlers.BuildErrorResponseBody(lastStatus, "ollama upstream request failed")
	}
	for hKey, values := range lastHeaders {
		for _, value := range values {
			c.Header(hKey, value)
		}
	}
	c.Header("Content-Type", "application/json")
	c.Writer.WriteHeader(lastStatus)
	_, _ = c.Writer.Write(lastBody)
}
