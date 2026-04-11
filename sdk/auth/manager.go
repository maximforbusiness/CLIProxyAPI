package auth

import (
	"context"
	"fmt"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

// Manager aggregates authenticators and coordinates persistence via a token store.
type Manager struct {
	authenticators map[string]Authenticator
	store          coreauth.Store
}

// NewManager constructs a manager with the provided token store and authenticators.
// If store is nil, the caller must set it later using SetStore.
func NewManager(store coreauth.Store, authenticators ...Authenticator) *Manager {
	mgr := &Manager{
		authenticators: make(map[string]Authenticator),
		store:          store,
	}
	for i := range authenticators {
		mgr.Register(authenticators[i])
	}
	return mgr
}

// Register adds or replaces an authenticator keyed by its provider identifier.
func (m *Manager) Register(a Authenticator) {
	if a == nil {
		return
	}
	if m.authenticators == nil {
		m.authenticators = make(map[string]Authenticator)
	}
	m.authenticators[a.Provider()] = a
}

// SetStore updates the token store used for persistence.
func (m *Manager) SetStore(store coreauth.Store) {
	m.store = store
}

// Login executes the provider login flow and persists the resulting auth record.
func (m *Manager) Login(ctx context.Context, provider string, cfg *config.Config, opts *LoginOptions) (*coreauth.Auth, string, error) {
	auth, ok := m.authenticators[provider]
	if !ok {
		return nil, "", fmt.Errorf("cliproxy auth: authenticator %s not registered", provider)
	}

	isCodex := provider == "codex"
	if isCodex {
		fmt.Println("[codex-auth-debug] manager login start")
	}

	record, err := auth.Login(ctx, cfg, opts)
	if err != nil {
		if isCodex {
			fmt.Printf("[codex-auth-debug] manager login failed before save: %v\n", err)
		}
		return nil, "", err
	}
	if record == nil {
		return nil, "", fmt.Errorf("cliproxy auth: authenticator %s returned nil record", provider)
	}
	if isCodex {
		fmt.Printf("[codex-auth-debug] manager received auth record: id=%q file=%q provider=%q\n", record.ID, record.FileName, record.Provider)
	}

	if m.store == nil {
		if isCodex {
			fmt.Println("[codex-auth-debug] manager store is nil, skipping save")
		}
		return record, "", nil
	}

	if cfg != nil {
		if dirSetter, ok := m.store.(interface{ SetBaseDir(string) }); ok {
			dirSetter.SetBaseDir(cfg.AuthDir)
		}
	}
	if isCodex {
		authDir := ""
		if cfg != nil {
			authDir = cfg.AuthDir
		}
		fmt.Printf("[codex-auth-debug] manager saving auth record to auth_dir=%q\n", authDir)
	}

	savedPath, err := m.store.Save(ctx, record)
	if err != nil {
		if isCodex {
			fmt.Printf("[codex-auth-debug] manager save failed: %v\n", err)
		}
		return record, "", err
	}
	if isCodex {
		fmt.Printf("[codex-auth-debug] manager save completed: %q\n", savedPath)
	}
	return record, savedPath, nil
}
