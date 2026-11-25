package service

import (
	"context"
	"fmt"
	"log/slog"
	"reflect"
	"sort"
	"sync"

	"nodo/agent/internal/media"
)

// Persister saves the list of definitions.
type Persister interface {
	Save([]Service) error
}

// View is a definition together with its live status.
type View struct {
	Service Service `json:"service"`
	Status  Status  `json:"status"`
}

type item struct {
	svc Service
	rt  *Runtime
}

// Manager owns every service of the agent: definitions, persistence and running instances.
type Manager struct {
	ctx   context.Context
	cfg   media.Config
	log   *slog.Logger
	store Persister

	mu    sync.Mutex
	items map[string]*item
}

// ErrNotFound is returned for an unknown service id.
var ErrNotFound = fmt.Errorf("service not found")

// ErrExists is returned when creating a service whose id is taken.
var ErrExists = fmt.Errorf("a service with that id already exists")

func NewManager(ctx context.Context, cfg media.Config, log *slog.Logger, store Persister) *Manager {
	return &Manager{ctx: ctx, cfg: cfg, log: log, store: store, items: map[string]*item{}}
}

// Restore loads saved definitions and starts the enabled ones. A definition that no longer validates
// is kept (stopped) so the user can fix it instead of losing it.
func (m *Manager) Restore(saved []Service) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, svc := range saved {
		svc.Normalize()
		it := &item{svc: svc}
		m.items[svc.ID] = it
		if !svc.Enabled {
			continue
		}
		if err := svc.Validate(m.cfg); err != nil {
			m.log.Warn("saved service is not valid and stays stopped", "service", svc.ID, "error", err)
			continue
		}
		rt, err := Start(m.ctx, svc, m.cfg, m.log)
		if err != nil {
			m.log.Warn("cannot start saved service", "service", svc.ID, "error", err)
			continue
		}
		it.rt = rt
	}
}

func (m *Manager) viewLocked(it *item) View {
	st := stoppedStatus(it.svc)
	if it.rt != nil {
		st = it.rt.Status()
	}
	return View{Service: it.svc, Status: st}
}

// List returns every service, ordered by name.
func (m *Manager) List() []View {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]View, 0, len(m.items))
	for _, it := range m.items {
		out = append(out, m.viewLocked(it))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Service.Name < out[j].Service.Name })
	return out
}

func (m *Manager) Get(id string) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	it, ok := m.items[id]
	if !ok {
		return View{}, ErrNotFound
	}
	return m.viewLocked(it), nil
}

// Create adds a new service.
func (m *Manager) Create(svc Service) (View, error) {
	svc.Normalize()
	if err := svc.Validate(m.cfg); err != nil {
		return View{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.items[svc.ID]; ok {
		return View{}, ErrExists
	}
	if err := m.persistLocked(svc.ID, &svc); err != nil {
		return View{}, err
	}
	it := &item{svc: svc}
	m.items[svc.ID] = it
	if svc.Enabled {
		if err := m.startLocked(it); err != nil {
			return View{}, err
		}
	}
	return m.viewLocked(it), nil
}

// Update replaces a service. A change that only touches the output profile is applied to the running
// service without restarting it; any other change restarts it.
func (m *Manager) Update(svc Service) (View, error) {
	svc.Normalize()
	if err := svc.Validate(m.cfg); err != nil {
		return View{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	it, ok := m.items[svc.ID]
	if !ok {
		return View{}, ErrNotFound
	}
	if err := m.persistLocked(svc.ID, &svc); err != nil {
		return View{}, err
	}
	old := it.svc
	it.svc = svc

	structural := !reflect.DeepEqual(old.Inputs, svc.Inputs) || !reflect.DeepEqual(old.Outputs, svc.Outputs) ||
		old.Backup != svc.Backup || old.Enabled != svc.Enabled
	switch {
	case it.rt != nil && !structural:
		if !reflect.DeepEqual(old.Profile, svc.Profile) {
			if err := it.rt.UpdateProfile(svc.Profile); err != nil {
				return View{}, err
			}
		}
	default:
		if it.rt != nil {
			it.rt.Stop()
			it.rt = nil
		}
		if svc.Enabled {
			if err := m.startLocked(it); err != nil {
				return View{}, err
			}
		}
	}
	return m.viewLocked(it), nil
}

// SetEnabled starts or stops a service and remembers the choice.
func (m *Manager) SetEnabled(id string, enabled bool) (View, error) {
	m.mu.Lock()
	it, ok := m.items[id]
	if !ok {
		m.mu.Unlock()
		return View{}, ErrNotFound
	}
	svc := it.svc
	m.mu.Unlock()
	svc.Enabled = enabled
	return m.Update(svc)
}

// Delete stops and removes a service.
func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	it, ok := m.items[id]
	if !ok {
		return ErrNotFound
	}
	if err := m.persistLocked(id, nil); err != nil {
		return err
	}
	if it.rt != nil {
		it.rt.Stop()
	}
	delete(m.items, id)
	return nil
}

// Switch moves a running service to another input.
func (m *Manager) Switch(id string, input int) error {
	m.mu.Lock()
	it, ok := m.items[id]
	var rt *Runtime
	if ok {
		rt = it.rt
	}
	m.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	if rt == nil {
		return fmt.Errorf("service is not running")
	}
	return rt.SwitchTo(input)
}

// StopAll ends every running service, for shutdown.
func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, it := range m.items {
		if it.rt != nil {
			it.rt.Stop()
			it.rt = nil
		}
	}
}

func (m *Manager) startLocked(it *item) error {
	rt, err := Start(m.ctx, it.svc, m.cfg, m.log)
	if err != nil {
		return err
	}
	it.rt = rt
	return nil
}

// persistLocked saves the list as it would be after replacing (svc != nil) or removing (svc == nil) one entry.
func (m *Manager) persistLocked(id string, svc *Service) error {
	list := make([]Service, 0, len(m.items)+1)
	for key, it := range m.items {
		if key != id {
			list = append(list, it.svc)
		}
	}
	if svc != nil {
		list = append(list, *svc)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	return m.store.Save(list)
}
