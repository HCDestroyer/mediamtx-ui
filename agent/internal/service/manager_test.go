package service

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"nodo/agent/internal/media"
)

type memStore struct {
	mu   sync.Mutex
	last []Service
	fail error
}

func (m *memStore) Save(s []Service) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail != nil {
		return m.fail
	}
	m.last = append([]Service(nil), s...)
	return nil
}

func newManager(t *testing.T) (*Manager, *memStore) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	st := &memStore{}
	m := NewManager(ctx, media.Config{}, quiet, st)
	t.Cleanup(m.StopAll)
	return m, st
}

func TestCreateStartsAndPersists(t *testing.T) {
	m, st := newManager(t)
	v, err := m.Create(testService(freePort(t), freePort(t), freePort(t)))
	if err != nil {
		t.Fatal(err)
	}
	if v.Status.State != "running" || len(st.last) != 1 || st.last[0].ID != "deportes" {
		t.Fatalf("create: %+v persisted=%d", v.Status.State, len(st.last))
	}
	if _, err := m.Create(testService(1, 2, 3)); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate id: %v", err)
	}
}

func TestDisabledServiceStaysStopped(t *testing.T) {
	m, _ := newManager(t)
	svc := testService(freePort(t), freePort(t), freePort(t))
	svc.Enabled = false
	v, err := m.Create(svc)
	if err != nil || v.Status.State != "stopped" {
		t.Fatalf("%v %+v", err, v.Status.State)
	}
	v, err = m.SetEnabled("deportes", true)
	if err != nil || v.Status.State != "running" {
		t.Fatalf("enable: %v %v", err, v.Status.State)
	}
	v, err = m.SetEnabled("deportes", false)
	if err != nil || v.Status.State != "stopped" {
		t.Fatalf("disable: %v %v", err, v.Status.State)
	}
	if _, err := m.SetEnabled("nope", true); !errors.Is(err, ErrNotFound) {
		t.Fatal("unknown id")
	}
}

func TestProfileChangeIsHotButInputChangeRestarts(t *testing.T) {
	m, _ := newManager(t)
	svc := testService(freePort(t), freePort(t), freePort(t))
	if _, err := m.Create(svc); err != nil {
		t.Fatal(err)
	}
	first := m.items["deportes"].rt
	time.Sleep(1200 * time.Millisecond) // let the uptime counter move

	hot := svc
	hot.Profile.Streams = append(hot.Profile.Streams[:0:0], svc.Profile.Streams...)
	hot.Profile.Streams[1].PID = 300
	if _, err := m.Update(hot); err != nil {
		t.Fatal(err)
	}
	if m.items["deportes"].rt != first {
		t.Fatal("a profile change must not restart the service")
	}
	if up := first.Status().UptimeSec; up < 1 {
		t.Fatalf("uptime %d: the service restarted", up)
	}
	if got := first.Status().Mapping[1].OutPID; got != 300 {
		t.Fatalf("the running service did not take the new PID: %d", got)
	}

	cold := hot
	cold.Inputs = append([]Input(nil), hot.Inputs...)
	cold.Inputs[0].TimeoutSec = 3
	if _, err := m.Update(cold); err != nil {
		t.Fatal(err)
	}
	if m.items["deportes"].rt == first {
		t.Fatal("an input change must restart the service")
	}
}

func TestInvalidUpdateChangesNothing(t *testing.T) {
	m, st := newManager(t)
	svc := testService(freePort(t), freePort(t), freePort(t))
	if _, err := m.Create(svc); err != nil {
		t.Fatal(err)
	}
	bad := svc
	bad.Profile.ServiceID = 0
	if _, err := m.Update(bad); err == nil {
		t.Fatal("expected a validation error")
	}
	if m.items["deportes"].svc.Profile.ServiceID != 100 || st.last[0].Profile.ServiceID != 100 {
		t.Fatal("a rejected update must leave the definition and the file untouched")
	}
}

func TestFailedSaveLeavesTheServiceAlone(t *testing.T) {
	m, st := newManager(t)
	svc := testService(freePort(t), freePort(t), freePort(t))
	if _, err := m.Create(svc); err != nil {
		t.Fatal(err)
	}
	st.fail = errors.New("disk full")
	if err := m.Delete("deportes"); err == nil {
		t.Fatal("expected the save error")
	}
	if _, err := m.Get("deportes"); err != nil {
		t.Fatal("the service must still exist when it could not be saved")
	}
	st.fail = nil
	if err := m.Delete("deportes"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Get("deportes"); !errors.Is(err, ErrNotFound) || len(st.last) != 0 {
		t.Fatal("delete did not take effect")
	}
}

func TestRestoreStartsOnlyEnabledAndValid(t *testing.T) {
	m, _ := newManager(t)
	on := testService(freePort(t), freePort(t), freePort(t))
	off := testService(freePort(t), freePort(t), freePort(t))
	off.ID, off.Enabled = "apagado", false
	broken := testService(1, 2, 3)
	broken.ID = "roto"
	broken.Inputs[0].URL = "nonsense"
	m.Restore([]Service{on, off, broken})

	states := map[string]string{}
	for _, v := range m.List() {
		states[v.Service.ID] = v.Status.State
	}
	if states["deportes"] != "running" || states["apagado"] != "stopped" || states["roto"] != "stopped" || len(states) != 3 {
		t.Fatalf("restore: %v", states)
	}
}

func TestSwitchNeedsARunningService(t *testing.T) {
	m, _ := newManager(t)
	svc := testService(freePort(t), freePort(t), freePort(t))
	svc.Enabled = false
	if _, err := m.Create(svc); err != nil {
		t.Fatal(err)
	}
	if err := m.Switch("deportes", 0); err == nil {
		t.Fatal("a stopped service cannot switch")
	}
	if err := m.Switch("nope", 0); !errors.Is(err, ErrNotFound) {
		t.Fatal("unknown id")
	}
}
