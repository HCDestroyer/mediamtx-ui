// Package auth holds the panel accounts of the agent: passwords hashed with PBKDF2-HMAC-SHA256, signed
// session tokens that survive restarts, and a login rate limiter. Only the standard library is used.
package auth

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Iterations is the PBKDF2 cost for new passwords (OWASP 2023 guidance for HMAC-SHA256). Tests lower it.
var Iterations = 600_000

const (
	usersFile  = "users.json"
	secretFile = "secret"
	// MinPassword is the shortest accepted password, in characters.
	MinPassword = 8
	maxPassword = 256
	// SessionTTL is how long a login lasts.
	SessionTTL = 12 * time.Hour
)

var (
	ErrExists      = errors.New("an account already exists")
	ErrNoAccount   = errors.New("account not found")
	ErrBadLogin    = errors.New("wrong username or password")
	ErrWeak        = fmt.Errorf("the password must have at least %d characters", MinPassword)
	ErrBadUsername = errors.New("the username must be 1 to 64 characters with no spaces")
)

type account struct {
	Name       string `json:"name"`
	Salt       []byte `json:"salt"`
	Iterations int    `json:"iterations"`
	Hash       []byte `json:"hash"`
	// Epoch changes with every password change and invalidates the sessions issued before it.
	Epoch int `json:"epoch"`
}

type usersDoc struct {
	Version  int       `json:"version"`
	Accounts []account `json:"accounts"`
}

type fileStamp struct {
	mod  time.Time
	size int64
}

// Store reads and writes the accounts and signs sessions.
type Store struct {
	dir string
	now func() time.Time

	mu       sync.Mutex
	accounts []account
	loaded   fileStamp // users.json as last read, so `passwd` run while the agent is up takes effect
	secret   []byte
	dummy    account // verified against when the user does not exist, so timing does not reveal it
}

// Open loads <dir>/users.json (a missing file means no accounts) and the signing secret, creating it.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, now: time.Now}
	data, err := os.ReadFile(filepath.Join(dir, usersFile))
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		var doc usersDoc
		if err := json.Unmarshal(data, &doc); err != nil {
			return nil, fmt.Errorf("%s is not valid JSON: %w", usersFile, err)
		}
		s.accounts = doc.Accounts
		s.loaded = stampOf(filepath.Join(dir, usersFile))
	}
	if s.secret, err = loadSecret(filepath.Join(dir, secretFile)); err != nil {
		return nil, err
	}
	s.dummy, err = hashPassword("dummy", "dummy-password")
	return s, err
}

func loadSecret(path string) ([]byte, error) {
	if b, err := os.ReadFile(path); err == nil && len(b) >= 32 {
		return b, nil
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, writeFile(path, b)
}

func writeFile(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func stampOf(path string) fileStamp {
	info, err := os.Stat(path)
	if err != nil {
		return fileStamp{}
	}
	return fileStamp{info.ModTime(), info.Size()}
}

// refresh rereads users.json when another process (the passwd command) changed it. Caller holds s.mu.
func (s *Store) refresh() {
	path := filepath.Join(s.dir, usersFile)
	stamp := stampOf(path)
	if stamp == s.loaded {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var doc usersDoc
	if json.Unmarshal(data, &doc) == nil {
		s.accounts, s.loaded = doc.Accounts, stamp
	}
}

func (s *Store) save() error {
	data, err := json.MarshalIndent(usersDoc{Version: 1, Accounts: s.accounts}, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(s.dir, usersFile)
	if err := writeFile(path, data); err != nil {
		return err
	}
	s.loaded = stampOf(path)
	return nil
}

func validUsername(name string) bool {
	n := utf8.RuneCountInString(name)
	return n >= 1 && n <= 64 && name == strings.TrimSpace(name) && !strings.ContainsAny(name, " \t\r\n\x00")
}

func validPassword(pw string) error {
	if utf8.RuneCountInString(pw) < MinPassword || len(pw) > maxPassword {
		return ErrWeak
	}
	return nil
}

func hashPassword(name, pw string) (account, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return account{}, err
	}
	hash, err := pbkdf2.Key(sha256.New, pw, salt, Iterations, 32)
	return account{Name: name, Salt: salt, Iterations: Iterations, Hash: hash}, err
}

func (a account) matches(pw string) bool {
	hash, err := pbkdf2.Key(sha256.New, pw, a.Salt, a.Iterations, len(a.Hash))
	return err == nil && subtle.ConstantTimeCompare(hash, a.Hash) == 1
}

// HasAccounts reports whether the first-run setup is done.
func (s *Store) HasAccounts() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refresh()
	return len(s.accounts) > 0
}

func (s *Store) find(name string) int {
	for i, a := range s.accounts {
		if a.Name == name {
			return i
		}
	}
	return -1
}

// Create adds the first account; it fails when one exists (first-run setup cannot take over a panel).
func (s *Store) Create(name, pw string) error {
	if !validUsername(name) {
		return ErrBadUsername
	}
	if err := validPassword(pw); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refresh()
	if len(s.accounts) > 0 {
		return ErrExists
	}
	a, err := hashPassword(name, pw)
	if err != nil {
		return err
	}
	s.accounts = append(s.accounts, a)
	return s.save()
}

// Set creates the account or resets its password (the `passwd` command); older sessions stop working.
func (s *Store) Set(name, pw string) error {
	if !validUsername(name) {
		return ErrBadUsername
	}
	if err := validPassword(pw); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refresh()
	a, err := hashPassword(name, pw)
	if err != nil {
		return err
	}
	if i := s.find(name); i >= 0 {
		a.Epoch = s.accounts[i].Epoch + 1
		s.accounts[i] = a
	} else {
		s.accounts = append(s.accounts, a)
	}
	return s.save()
}

// Verify checks a login and returns the account's session epoch.
func (s *Store) Verify(name, pw string) (epoch int, err error) {
	s.mu.Lock()
	s.refresh()
	i := s.find(name)
	acc := s.dummy
	if i >= 0 {
		acc = s.accounts[i]
	}
	s.mu.Unlock()
	ok := acc.matches(pw)
	if i < 0 || !ok {
		return 0, ErrBadLogin
	}
	return acc.Epoch, nil
}

// ChangePassword replaces the password after checking the current one; every session of the account ends.
func (s *Store) ChangePassword(name, current, next string) error {
	if _, err := s.Verify(name, current); err != nil {
		return err
	}
	return s.Set(name, next)
}

// ---- sessions: "v1.<payload>.<mac>", payload = {"u":name,"e":epoch,"x":expiry unix} ----

type claims struct {
	User   string `json:"u"`
	Epoch  int    `json:"e"`
	Expiry int64  `json:"x"`
}

func (s *Store) mac(payload string) string {
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// Issue creates a session token for an account that just logged in.
func (s *Store) Issue(name string, epoch int) (token string, expires time.Time) {
	expires = s.now().Add(SessionTTL)
	raw, _ := json.Marshal(claims{User: name, Epoch: epoch, Expiry: expires.Unix()})
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return "v1." + payload + "." + s.mac(payload), expires
}

// Check validates a token: signature, expiry, and that the password has not changed since it was issued.
func (s *Store) Check(token string) (user string, ok bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return "", false
	}
	if !hmac.Equal([]byte(parts[2]), []byte(s.mac(parts[1]))) {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", false
	}
	var c claims
	if json.Unmarshal(raw, &c) != nil || s.now().Unix() >= c.Expiry {
		return "", false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refresh()
	i := s.find(c.User)
	if i < 0 || s.accounts[i].Epoch != c.Epoch {
		return "", false
	}
	return c.User, true
}

// ---- rate limiter ----

// Limiter slows down password guessing per key (for example the client address): the first failures are
// free, then the wait doubles up to a maximum.
type Limiter struct {
	mu       sync.Mutex
	now      func() time.Time
	free     int
	base     time.Duration
	max      time.Duration
	attempts map[string]*attempt
}

type attempt struct {
	failures int
	until    time.Time
}

// NewLimiter allows `free` failures, then waits base, 2*base, 4*base… up to max.
func NewLimiter(free int, base, max time.Duration) *Limiter {
	return &Limiter{now: time.Now, free: free, base: base, max: max, attempts: map[string]*attempt{}}
}

// Wait returns how long the key must wait before trying again; zero means go ahead.
func (l *Limiter) Wait(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if a := l.attempts[key]; a != nil {
		if d := a.until.Sub(l.now()); d > 0 {
			return d
		}
	}
	return 0
}

// Fail records a wrong password.
func (l *Limiter) Fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.attempts) > 10_000 { // bounded memory under a scan from many addresses
		l.attempts = map[string]*attempt{}
	}
	a := l.attempts[key]
	if a == nil {
		a = &attempt{}
		l.attempts[key] = a
	}
	a.failures++
	if over := a.failures - l.free; over > 0 {
		wait := l.base << min(over-1, 20)
		if wait > l.max || wait <= 0 {
			wait = l.max
		}
		a.until = l.now().Add(wait)
	}
}

// Succeed forgets the key's failures.
func (l *Limiter) Succeed(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, key)
}
