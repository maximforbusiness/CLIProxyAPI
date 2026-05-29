package executor

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
	"github.com/tidwall/gjson"
)

func TestOpenAICompatExecutorNvidiaStableDiffusionPath(t *testing.T) {
	var gotPath string
	var gotBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = body
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"image":"Zm9vYmFy","finish_reason":"SUCCESS","seed":42}`))
	}))
	defer server.Close()

	previousEndpoint := nvidiaStableDiffusionEndpoint
	nvidiaStableDiffusionEndpoint = server.URL + "/v1/genai/stabilityai/stable-diffusion-3-medium"
	defer func() { nvidiaStableDiffusionEndpoint = previousEndpoint }()

	executor := NewOpenAICompatExecutor("openai-compatibility", &config.Config{})
	auth := &cliproxyauth.Auth{
		Provider: "openai-compatibility",
		Attributes: map[string]string{
			"api_key":  "test-key",
			"base_url": "https://integrate.api.nvidia.com/v1",
		},
	}
	payload := []byte(`{"model":"stable-diffusion-3-medium","messages":[{"role":"user","content":"birthday card for woman"}],"stream":false}`)
	resp, err := executor.Execute(context.Background(), auth, cliproxyexecutor.Request{
		Model:   "stabilityai/stable-diffusion-3-medium",
		Payload: payload,
	}, cliproxyexecutor.Options{
		SourceFormat: sdktranslator.FromString("openai"),
		Stream:       false,
	})
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}

	if gotPath != "/v1/genai/stabilityai/stable-diffusion-3-medium" {
		t.Fatalf("path = %q, want %q", gotPath, "/v1/genai/stabilityai/stable-diffusion-3-medium")
	}
	if gjson.GetBytes(gotBody, "prompt").String() != "birthday card for woman" {
		t.Fatalf("prompt = %q, want %q", gjson.GetBytes(gotBody, "prompt").String(), "birthday card for woman")
	}
	if gjson.GetBytes(resp.Payload, "choices.0.message.content").String() != "Zm9vYmFy" {
		t.Fatalf("content = %q, want %q", gjson.GetBytes(resp.Payload, "choices.0.message.content").String(), "Zm9vYmFy")
	}
}

func TestOpenAICompatExecutorNvidiaStableDiffusionMissingPrompt(t *testing.T) {
	executor := NewOpenAICompatExecutor("openai-compatibility", &config.Config{})
	auth := &cliproxyauth.Auth{
		Provider: "openai-compatibility",
		Attributes: map[string]string{
			"api_key":  "test-key",
			"base_url": "https://integrate.api.nvidia.com/v1",
		},
	}
	payload := []byte(`{"model":"stable-diffusion-3-medium","messages":[],"stream":false}`)
	_, err := executor.Execute(context.Background(), auth, cliproxyexecutor.Request{
		Model:   "stabilityai/stable-diffusion-3-medium",
		Payload: payload,
	}, cliproxyexecutor.Options{
		SourceFormat: sdktranslator.FromString("openai"),
		Stream:       false,
	})
	if err == nil {
		t.Fatalf("expected error")
	}
	se, ok := err.(interface{ StatusCode() int })
	if !ok {
		t.Fatalf("expected status error, got %T", err)
	}
	if se.StatusCode() != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", se.StatusCode(), http.StatusBadRequest)
	}
}

func TestOpenAICompatExecutorNvidiaStableDiffusionSizeMappedToAspectRatio(t *testing.T) {
	var gotBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotBody = body
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"image":"Zm9vYmFy","finish_reason":"SUCCESS","seed":42}`))
	}))
	defer server.Close()

	previousEndpoint := nvidiaStableDiffusionEndpoint
	nvidiaStableDiffusionEndpoint = server.URL + "/v1/genai/stabilityai/stable-diffusion-3-medium"
	defer func() { nvidiaStableDiffusionEndpoint = previousEndpoint }()

	executor := NewOpenAICompatExecutor("openai-compatibility", &config.Config{})
	auth := &cliproxyauth.Auth{
		Provider: "openai-compatibility",
		Attributes: map[string]string{
			"api_key":  "test-key",
			"base_url": "https://integrate.api.nvidia.com/v1",
		},
	}

	payload := []byte(`{"model":"stable-diffusion-3-medium","prompt":"birthday card for woman","size":"1024x1024","stream":false}`)
	_, err := executor.Execute(context.Background(), auth, cliproxyexecutor.Request{
		Model:   "stabilityai/stable-diffusion-3-medium",
		Payload: payload,
	}, cliproxyexecutor.Options{
		SourceFormat: sdktranslator.FromString("openai"),
		Stream:       false,
	})
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}

	if got := gjson.GetBytes(gotBody, "aspect_ratio").String(); got != "1:1" {
		t.Fatalf("aspect_ratio = %q, want %q", got, "1:1")
	}
	if gjson.GetBytes(gotBody, "width").Exists() {
		t.Fatalf("width must not be sent to NVIDIA SD3 payload")
	}
	if gjson.GetBytes(gotBody, "height").Exists() {
		t.Fatalf("height must not be sent to NVIDIA SD3 payload")
	}
}
