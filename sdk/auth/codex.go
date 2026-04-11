package auth

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/auth/codex"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/browser"
	// legacy client removed
	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/misc"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/util"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

// CodexAuthenticator implements the OAuth login flow for Codex accounts.
type CodexAuthenticator struct {
	CallbackPort int
}

// NewCodexAuthenticator constructs a Codex authenticator with default settings.
func NewCodexAuthenticator() *CodexAuthenticator {
	return &CodexAuthenticator{CallbackPort: 1455}
}

func (a *CodexAuthenticator) Provider() string {
	return "codex"
}

func (a *CodexAuthenticator) RefreshLead() *time.Duration {
	return new(5 * 24 * time.Hour)
}

func (a *CodexAuthenticator) Login(ctx context.Context, cfg *config.Config, opts *LoginOptions) (*coreauth.Auth, error) {
	if cfg == nil {
		return nil, fmt.Errorf("cliproxy auth: configuration is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if opts == nil {
		opts = &LoginOptions{}
	}

	if shouldUseCodexDeviceFlow(opts) {
		return a.loginWithDeviceFlow(ctx, cfg, opts)
	}

	callbackPort := a.CallbackPort
	if opts.CallbackPort > 0 {
		callbackPort = opts.CallbackPort
	}

	pkceCodes, err := codex.GeneratePKCECodes()
	if err != nil {
		return nil, fmt.Errorf("codex pkce generation failed: %w", err)
	}

	state, err := misc.GenerateRandomState()
	if err != nil {
		return nil, fmt.Errorf("codex state generation failed: %w", err)
	}

	oauthServer := codex.NewOAuthServer(callbackPort)
	if err = oauthServer.Start(); err != nil {
		if strings.Contains(err.Error(), "already in use") {
			return nil, codex.NewAuthenticationError(codex.ErrPortInUse, err)
		}
		return nil, codex.NewAuthenticationError(codex.ErrServerStartFailed, err)
	}
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if stopErr := oauthServer.Stop(stopCtx); stopErr != nil {
			log.Warnf("codex oauth server stop error: %v", stopErr)
		}
	}()

	authSvc := codex.NewCodexAuth(cfg)

	authURL, err := authSvc.GenerateAuthURL(state, pkceCodes)
	if err != nil {
		return nil, fmt.Errorf("codex authorization url generation failed: %w", err)
	}

	if !opts.NoBrowser {
		fmt.Println("Opening browser for Codex authentication")
		if !browser.IsAvailable() {
			log.Warn("No browser available; please open the URL manually")
			util.PrintSSHTunnelInstructions(callbackPort)
			fmt.Printf("Visit the following URL to continue authentication:\n%s\n", authURL)
		} else if err = browser.OpenURL(authURL); err != nil {
			log.Warnf("Failed to open browser automatically: %v", err)
			util.PrintSSHTunnelInstructions(callbackPort)
			fmt.Printf("Visit the following URL to continue authentication:\n%s\n", authURL)
		}
	} else {
		util.PrintSSHTunnelInstructions(callbackPort)
		fmt.Printf("Visit the following URL to continue authentication:\n%s\n", authURL)
	}

	fmt.Println("Waiting for Codex authentication callback...")

	callbackCh := make(chan *codex.OAuthResult, 1)
	callbackErrCh := make(chan error, 1)
	manualDescription := ""
	resultSource := "listener"

	go func() {
		result, errWait := oauthServer.WaitForCallback(5 * time.Minute)
		if errWait != nil {
			callbackErrCh <- errWait
			return
		}
		callbackCh <- result
	}()

	var result *codex.OAuthResult
	var manualPromptTimer *time.Timer
	var manualPromptC <-chan time.Time
	if opts.Prompt != nil {
		manualPromptTimer = time.NewTimer(15 * time.Second)
		manualPromptC = manualPromptTimer.C
		defer manualPromptTimer.Stop()
	}

	var manualInputCh <-chan string
	var manualInputErrCh <-chan error

waitForCallback:
	for {
		select {
		case result = <-callbackCh:
			break waitForCallback
		case err = <-callbackErrCh:
			if strings.Contains(err.Error(), "timeout") {
				return nil, codex.NewAuthenticationError(codex.ErrCallbackTimeout, err)
			}
			return nil, err
		case <-manualPromptC:
			manualPromptC = nil
			if manualPromptTimer != nil {
				manualPromptTimer.Stop()
			}
			select {
			case result = <-callbackCh:
				break waitForCallback
			case err = <-callbackErrCh:
				if strings.Contains(err.Error(), "timeout") {
					return nil, codex.NewAuthenticationError(codex.ErrCallbackTimeout, err)
				}
				return nil, err
			default:
			}
			manualInputCh, manualInputErrCh = misc.AsyncPrompt(opts.Prompt, "Paste the Codex callback URL (or press Enter to keep waiting): ")
			continue
		case input := <-manualInputCh:
			manualInputCh = nil
			manualInputErrCh = nil
			parsed, errParse := misc.ParseOAuthCallback(input)
			if errParse != nil {
				return nil, errParse
			}
			if parsed == nil {
				continue
			}
			manualDescription = parsed.ErrorDescription
			resultSource = "manual"
			result = &codex.OAuthResult{
				Code:  parsed.Code,
				State: parsed.State,
				Error: parsed.Error,
			}
			break waitForCallback
		case errManual := <-manualInputErrCh:
			return nil, errManual
		}
	}

	resultStatePreview := strings.TrimSpace(result.State)
	if len(resultStatePreview) > 12 {
		resultStatePreview = resultStatePreview[:12] + "..."
	}
	expectedStatePreview := strings.TrimSpace(state)
	if len(expectedStatePreview) > 12 {
		expectedStatePreview = expectedStatePreview[:12] + "..."
	}
	fmt.Printf("[codex-auth-debug] callback received via %s: code_present=%t code_len=%d state_present=%t state=%q error=%q\n",
		resultSource,
		result.Code != "",
		len(result.Code),
		result.State != "",
		resultStatePreview,
		result.Error,
	)
	fmt.Printf("[codex-auth-debug] expected state: len=%d value=%q\n", len(state), expectedStatePreview)

	if result.Error != "" {
		return nil, codex.NewOAuthError(result.Error, manualDescription, http.StatusBadRequest)
	}

	if result.State != state {
		fmt.Println("[codex-auth-debug] callback state mismatch")
		return nil, codex.NewAuthenticationError(codex.ErrInvalidState, fmt.Errorf("state mismatch"))
	}

	fmt.Println("[codex-auth-debug] callback state matched")
	fmt.Printf("[codex-auth-debug] starting token exchange redirect=%s\n", codex.RedirectURI)

	authBundle, err := authSvc.ExchangeCodeForTokens(ctx, result.Code, pkceCodes)
	if err != nil {
		fmt.Printf("[codex-auth-debug] token exchange failed: %v\n", err)
		return nil, codex.NewAuthenticationError(codex.ErrCodeExchangeFailed, err)
	}
	fmt.Printf("[codex-auth-debug] token exchange completed: email=%q account_id_present=%t refresh_present=%t api_key_present=%t\n",
		authBundle.TokenData.Email,
		strings.TrimSpace(authBundle.TokenData.AccountID) != "",
		strings.TrimSpace(authBundle.TokenData.RefreshToken) != "",
		strings.TrimSpace(authBundle.APIKey) != "",
	)

	fmt.Println("[codex-auth-debug] building auth record")
	record, err := a.buildAuthRecord(authSvc, authBundle)
	if err != nil {
		fmt.Printf("[codex-auth-debug] build auth record failed: %v\n", err)
		return nil, err
	}
	fmt.Printf("[codex-auth-debug] build auth record completed: id=%q file=%q\n", record.ID, record.FileName)
	return record, nil
}
