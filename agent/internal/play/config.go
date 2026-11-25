// Package play serves services over plain HTTP like Astra's "HTTP Play": GET /play/<id> streams the
// stabilized MPEG-TS of a running service with no output configured, /play/playlist.m3u lists them,
// and access can be limited by client address (single IPs, CIDR ranges and named pools) and by user.
package play

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

const (
	ActionAllow = "allow"
	ActionDeny  = "deny"

	maxRules          = 200
	maxPools          = 100
	maxEntries        = 2000
	maxUsers          = 100
	defaultMaxViewers = 200
	tokenBytes        = 16
)

var namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$`)

// Pool is a named group of addresses ("hotel-modulators") that rules can refer to.
type Pool struct {
	Name string `json:"name"`
	// Entries are single addresses or CIDR ranges, IPv4 or IPv6.
	Entries []string `json:"entries"`
}

// Rule allows or blocks the clients that match it. Exactly one of Pool and Address is set.
type Rule struct {
	Action  string `json:"action"`
	Pool    string `json:"pool,omitempty"`
	Address string `json:"address,omitempty"`
}

// User is someone who may watch when authentication is required. The token goes in the playlist URL,
// so the password of a panel account never travels in a link.
type User struct {
	Name  string `json:"name"`
	Token string `json:"token"`
}

// Config is the whole HTTP play setup. Rules are evaluated in order and the first match wins.
type Config struct {
	Enabled     bool   `json:"enabled"`
	RequireAuth bool   `json:"requireAuth"`
	Default     string `json:"default"` // what happens when no rule matches: allow or deny
	MaxViewers  int    `json:"maxViewers"`
	Pools       []Pool `json:"pools"`
	Rules       []Rule `json:"rules"`
	Users       []User `json:"users"`
}

// DefaultConfig is secure by default: off until the operator turns it on.
func DefaultConfig() Config {
	return Config{Default: ActionAllow, MaxViewers: defaultMaxViewers, Pools: []Pool{}, Rules: []Rule{}, Users: []User{}}
}

func parsePrefix(entry string) (netip.Prefix, error) {
	entry = strings.TrimSpace(entry)
	if strings.Contains(entry, "/") {
		p, err := netip.ParsePrefix(entry)
		if err != nil {
			return netip.Prefix{}, fmt.Errorf("%q is not a valid address range", entry)
		}
		return p.Masked(), nil
	}
	a, err := netip.ParseAddr(entry)
	if err != nil {
		return netip.Prefix{}, fmt.Errorf("%q is not a valid IP address or range", entry)
	}
	return netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()), nil
}

// NewToken makes a random token for a user.
func NewToken() string {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		panic(err) // the system has no randomness: nothing safe can be done
	}
	return hex.EncodeToString(b)
}

// Normalize fixes what can be fixed (defaults, missing tokens) and rejects the rest. It returns a copy.
func Normalize(c Config) (Config, error) {
	if c.Default == "" {
		c.Default = ActionAllow
	}
	if c.Default != ActionAllow && c.Default != ActionDeny {
		return c, fmt.Errorf("default must be allow or deny")
	}
	if c.MaxViewers == 0 {
		c.MaxViewers = defaultMaxViewers
	}
	if c.MaxViewers < 1 || c.MaxViewers > 10000 {
		return c, errors.New("maxViewers must be between 1 and 10000")
	}
	c.Pools = append([]Pool{}, c.Pools...)
	c.Rules = append([]Rule{}, c.Rules...)
	c.Users = append([]User{}, c.Users...)
	if len(c.Pools) > maxPools || len(c.Rules) > maxRules || len(c.Users) > maxUsers {
		return c, errors.New("too many pools, rules or users")
	}

	pools := map[string]bool{}
	total := 0
	for i, p := range c.Pools {
		if !namePattern.MatchString(p.Name) {
			return c, fmt.Errorf("pool %q: use letters, digits, dot, dash or underscore (max 32)", p.Name)
		}
		if pools[p.Name] {
			return c, fmt.Errorf("pool %q is defined twice", p.Name)
		}
		pools[p.Name] = true
		entries := make([]string, 0, len(p.Entries))
		for _, e := range p.Entries {
			e = strings.TrimSpace(e)
			if e == "" {
				continue
			}
			if _, err := parsePrefix(e); err != nil {
				return c, fmt.Errorf("pool %q: %w", p.Name, err)
			}
			entries = append(entries, e)
		}
		total += len(entries)
		c.Pools[i].Entries = entries
	}
	if total > maxEntries {
		return c, fmt.Errorf("pools hold at most %d addresses in total", maxEntries)
	}

	for i, r := range c.Rules {
		if r.Action != ActionAllow && r.Action != ActionDeny {
			return c, fmt.Errorf("rule %d: the action must be allow or deny", i+1)
		}
		if (r.Pool == "") == (r.Address == "") {
			return c, fmt.Errorf("rule %d: set either a pool or an address", i+1)
		}
		if r.Pool != "" && !pools[r.Pool] {
			return c, fmt.Errorf("rule %d: pool %q does not exist", i+1, r.Pool)
		}
		if r.Address != "" {
			if _, err := parsePrefix(r.Address); err != nil {
				return c, fmt.Errorf("rule %d: %w", i+1, err)
			}
			c.Rules[i].Address = strings.TrimSpace(r.Address)
		}
	}

	names := map[string]bool{}
	tokens := map[string]bool{}
	for i, u := range c.Users {
		if !namePattern.MatchString(u.Name) {
			return c, fmt.Errorf("user %q: use letters, digits, dot, dash or underscore (max 32)", u.Name)
		}
		if names[u.Name] {
			return c, fmt.Errorf("user %q is defined twice", u.Name)
		}
		names[u.Name] = true
		if u.Token == "" {
			c.Users[i].Token = NewToken()
		} else if len(u.Token) < 16 || strings.ContainsAny(u.Token, " \t\r\n&#?\"'") {
			return c, fmt.Errorf("user %q: the token must have at least 16 characters and no spaces or URL symbols", u.Name)
		}
		if tokens[c.Users[i].Token] {
			return c, fmt.Errorf("two users share a token")
		}
		tokens[c.Users[i].Token] = true
	}
	if c.RequireAuth && len(c.Users) == 0 {
		return c, errors.New("authentication is required but there are no users")
	}
	return c, nil
}

// Matcher decides which client addresses may watch.
type Matcher struct {
	def   bool
	rules []compiledRule
}

type compiledRule struct {
	allow    bool
	prefixes []netip.Prefix
}

// Compile turns a normalized config into a matcher.
func Compile(c Config) (*Matcher, error) {
	pools := map[string][]netip.Prefix{}
	for _, p := range c.Pools {
		for _, e := range p.Entries {
			pr, err := parsePrefix(e)
			if err != nil {
				return nil, err
			}
			pools[p.Name] = append(pools[p.Name], pr)
		}
	}
	m := &Matcher{def: c.Default != ActionDeny}
	for _, r := range c.Rules {
		cr := compiledRule{allow: r.Action == ActionAllow}
		if r.Pool != "" {
			cr.prefixes = pools[r.Pool]
		} else {
			pr, err := parsePrefix(r.Address)
			if err != nil {
				return nil, err
			}
			cr.prefixes = []netip.Prefix{pr}
		}
		m.rules = append(m.rules, cr)
	}
	return m, nil
}

// Allowed applies the rules in order; the first one that contains the address decides.
func (m *Matcher) Allowed(ip netip.Addr) bool {
	ip = ip.Unmap()
	for _, r := range m.rules {
		for _, p := range r.prefixes {
			if p.Addr().Is4() == ip.Is4() && p.Contains(ip) {
				return r.allow
			}
		}
	}
	return m.def
}

// Store keeps the config in <dir>/play.json and the matcher compiled from it.
type Store struct {
	path string
	mu   sync.RWMutex
	cfg  Config
	m    *Matcher
}

// OpenStore loads the config; a missing file means the defaults (HTTP play off).
func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "play.json")}
	cfg := DefaultConfig()
	if data, err := os.ReadFile(s.path); err == nil {
		dec := json.NewDecoder(strings.NewReader(string(data)))
		if err := dec.Decode(&cfg); err != nil {
			return nil, fmt.Errorf("%s is not valid: %w", s.path, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	norm, err := Normalize(cfg)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", s.path, err)
	}
	m, err := Compile(norm)
	if err != nil {
		return nil, err
	}
	s.cfg, s.m = norm, m
	return s, nil
}

// Get returns a copy of the config.
func (s *Store) Get() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, _ := Normalize(s.cfg) // already valid: this only copies the slices
	return c
}

// Matcher returns the current matcher.
func (s *Store) Matcher() *Matcher {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.m
}

// Set validates, saves and activates a new config; on error nothing changes.
func (s *Store) Set(c Config) (Config, error) {
	norm, err := Normalize(c)
	if err != nil {
		return Config{}, err
	}
	m, err := Compile(norm)
	if err != nil {
		return Config{}, err
	}
	data, err := json.MarshalIndent(norm, "", "  ")
	if err != nil {
		return Config{}, err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil { // tokens are credentials
		return Config{}, err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return Config{}, err
	}
	s.mu.Lock()
	s.cfg, s.m = norm, m
	s.mu.Unlock()
	return norm, nil
}
