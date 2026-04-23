package ollama

import (
	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v6/sdk/api/handlers"
)

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
	return []map[string]any{
		{
			"id":       "web-search",
			"object":   "model",
			"created":  1700000000,
			"owned_by": "ollama",
		},
	}
}

// WebSearch handles the /ollama/api/web_search endpoint.
func (h *OllamaAPIHandler) WebSearch(c *gin.Context) {
	rawJSON, err := c.GetRawData()
	if err != nil {
		body := handlers.BuildErrorResponseBody(400, "invalid request: "+err.Error())
		c.Header("Content-Type", "application/json")
		c.Writer.WriteHeader(400)
		c.Writer.Write(body)
		return
	}

	modelName := "web-search"
	resp, upstreamHeaders, errMsg := h.ExecuteWithAuthManager(c.Request.Context(), h.HandlerType(), modelName, rawJSON, "")
	if errMsg != nil {
		h.WriteErrorResponse(c, errMsg)
		return
	}

	handlers.WriteUpstreamHeaders(c.Writer.Header(), upstreamHeaders)
	c.Header("Content-Type", "application/json")
	_, _ = c.Writer.Write(resp)
}