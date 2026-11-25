package service

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"nodo/agent/internal/addr"
	"nodo/agent/internal/media"
	"nodo/agent/internal/stabilizer"
	"nodo/agent/internal/ts"
)

const (
	batchPackets   = 7
	flushEvery     = 5 * time.Millisecond
	loopTick       = 20 * time.Millisecond
	healthTick     = 250 * time.Millisecond
	rateWindow     = time.Second
	chunkQueue     = 1024
	outputQueue    = 512
	restartBackoff = 2 * time.Second
	eventsKept     = 100
)

type chunk struct {
	idx  int
	data []byte
	at   time.Time
}

type inputErr struct {
	idx int
	err error
}

type command struct {
	kind    string // "switch" or "profile"
	index   int
	profile stabilizer.Profile
	reply   chan error
}

type inputRun struct {
	cfg      Input
	addr     addr.Address
	source   media.Input
	an       *ts.Analyzer
	timeout  time.Duration
	up       bool
	upSince  time.Time
	lastData time.Time
	bytes    uint64
	rateMark uint64
	kbps     float64
	lastErr  string
}

type outputRun struct {
	cfg     Output
	sink    media.Output
	queue   chan []byte
	mu      sync.Mutex // guards up and lastErr, written by the output goroutine
	up      bool
	lastErr string
	dropped uint64
}

// Runtime is a running service. All its processing happens in one goroutine (loop); everything
// else talks to it through channels, so the stabilizer needs no locks.
type Runtime struct {
	svc    Service
	log    *slog.Logger
	cancel context.CancelFunc
	done   chan struct{}

	inputs  []*inputRun
	outputs []*outputRun
	stab    *stabilizer.Stabilizer
	hub     *Hub

	chunks    chan chunk
	errs      chan inputErr
	cmds      chan command
	statusReq chan chan Status

	// owned by the loop
	active    int
	events    *ring
	batch     []byte
	lastFlush time.Time
	startedAt time.Time
	outMark   uint64
	outKbps   float64
	rateAt    time.Time
}

// Start launches a service. The context bounds its life; Stop also ends it.
func Start(parent context.Context, svc Service, cfg media.Config, log *slog.Logger) (*Runtime, error) {
	stab, err := stabilizer.New(svc.Profile)
	if err != nil {
		return nil, err
	}
	r := &Runtime{
		svc: svc, log: log.With("service", svc.ID), stab: stab, hub: newHub(), done: make(chan struct{}),
		chunks: make(chan chunk, chunkQueue), errs: make(chan inputErr, 16),
		cmds: make(chan command), statusReq: make(chan chan Status),
		active: -1, events: newRing(eventsKept),
	}
	for _, in := range svc.Inputs {
		a, err := addr.Parse(in.URL)
		if err != nil {
			return nil, err
		}
		src, err := media.NewInput(a, cfg)
		if err != nil {
			return nil, err
		}
		pnr, _ := a.Int("pnr", 0)
		r.inputs = append(r.inputs, &inputRun{cfg: in, addr: a, source: src, an: ts.NewAnalyzer(uint16(pnr)), timeout: in.InputTimeout(a)})
	}
	for _, out := range svc.Outputs {
		a, err := addr.Parse(out.URL)
		if err != nil {
			return nil, err
		}
		sink, err := media.NewOutput(a, cfg)
		if err != nil {
			return nil, err
		}
		r.outputs = append(r.outputs, &outputRun{cfg: out, sink: sink, queue: make(chan []byte, outputQueue)})
	}

	ctx, cancel := context.WithCancel(parent)
	r.cancel = cancel
	r.startedAt = time.Now()
	r.note("info", "Servicio iniciado")
	for i := range r.inputs {
		go r.readInput(ctx, i)
	}
	for i := range r.outputs {
		go r.writeOutput(ctx, i)
	}
	go r.loop(ctx)
	return r, nil
}

// Stop ends the service and waits for the loop to finish.
func (r *Runtime) Stop() {
	r.cancel()
	<-r.done
}

// Status returns a snapshot; it is answered by the loop so it never races with processing.
func (r *Runtime) Status() Status {
	reply := make(chan Status, 1)
	select {
	case r.statusReq <- reply:
		select {
		case s := <-reply:
			return s
		case <-time.After(time.Second):
		}
	case <-r.done:
	case <-time.After(time.Second):
	}
	return stoppedStatus(r.svc)
}

// SwitchTo moves the service to another input.
func (r *Runtime) SwitchTo(index int) error {
	return r.command(command{kind: "switch", index: index})
}

// UpdateProfile changes selectors, PIDs and CBR while running, without restarting anything.
func (r *Runtime) UpdateProfile(p stabilizer.Profile) error {
	return r.command(command{kind: "profile", profile: p})
}

func (r *Runtime) command(c command) error {
	c.reply = make(chan error, 1)
	select {
	case r.cmds <- c:
		return <-c.reply
	case <-r.done:
		return fmt.Errorf("service is not running")
	case <-time.After(2 * time.Second):
		return fmt.Errorf("service did not answer")
	}
}

// ---- goroutines that touch the network ----

func (r *Runtime) readInput(ctx context.Context, idx int) {
	in := r.inputs[idx]
	for ctx.Err() == nil {
		err := in.source.Run(ctx, func(data []byte) {
			c := chunk{idx: idx, data: append([]byte(nil), data...), at: time.Now()}
			select {
			case r.chunks <- c:
			default: // the loop is behind: drop rather than grow without bound
			}
		})
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			err = fmt.Errorf("input ended")
		}
		select {
		case r.errs <- inputErr{idx, err}:
		default:
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(restartBackoff):
		}
	}
}

func (r *Runtime) writeOutput(ctx context.Context, idx int) {
	out := r.outputs[idx]
	for ctx.Err() == nil {
		out.mu.Lock()
		out.up, out.lastErr = true, ""
		out.mu.Unlock()
		err := out.sink.Run(ctx, out.queue)
		out.mu.Lock()
		out.up = false
		if err != nil {
			out.lastErr = redactURL(err.Error())
		}
		out.mu.Unlock()
		if ctx.Err() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(restartBackoff):
		}
	}
}

// ---- the loop ----

func (r *Runtime) loop(ctx context.Context) {
	defer close(r.done)
	defer r.hub.Shutdown() // ends the HTTP viewers when the service stops
	tick := time.NewTicker(loopTick)
	health := time.NewTicker(healthTick)
	defer tick.Stop()
	defer health.Stop()
	r.rateAt = time.Now()
	for {
		select {
		case <-ctx.Done():
			r.flush(time.Now(), true)
			return
		case c := <-r.chunks:
			r.onChunk(c)
		case now := <-tick.C:
			r.stab.Tick(now, r.emit)
			r.flush(now, false)
		case now := <-health.C:
			r.checkHealth(now)
			r.updateRates(now)
		case e := <-r.errs:
			r.inputs[e.idx].lastErr = redactURL(e.err.Error())
			r.note("warn", fmt.Sprintf("Entrada %d: %s", e.idx+1, r.inputs[e.idx].lastErr))
		case reply := <-r.statusReq:
			reply <- r.snapshot(time.Now())
		case c := <-r.cmds:
			c.reply <- r.handle(c)
		}
	}
}

func (r *Runtime) onChunk(c chunk) {
	in := r.inputs[c.idx]
	in.lastData = c.at
	in.bytes += uint64(len(c.data))
	for off := 0; off+ts.PacketSize <= len(c.data); off += ts.PacketSize {
		p := c.data[off : off+ts.PacketSize]
		if in.an.Feed(p) && c.idx == r.active {
			// The source changed its PIDs or languages: follow it. The output does not change.
			r.stab.SetProgram(in.an.Current(), false)
			r.note("info", fmt.Sprintf("La entrada %d cambió su estructura; la salida sigue igual", c.idx+1))
		}
		if c.idx == r.active {
			r.stab.Process(p, c.at, r.emit)
		}
	}
}

func (r *Runtime) emit(p []byte) {
	r.batch = append(r.batch, p...)
	if len(r.batch) >= batchPackets*ts.PacketSize {
		r.dispatch()
	}
}

func (r *Runtime) flush(now time.Time, force bool) {
	if len(r.batch) > 0 && (force || now.Sub(r.lastFlush) >= flushEvery) {
		r.dispatch()
	}
	r.lastFlush = now
}

// dispatch hands the batch to every output. A slow output drops batches instead of stalling the others.
func (r *Runtime) dispatch() {
	data := append([]byte(nil), r.batch...)
	r.batch = r.batch[:0]
	r.hub.Publish(data)
	for _, out := range r.outputs {
		select {
		case out.queue <- data:
		default:
			out.mu.Lock()
			out.dropped++
			out.mu.Unlock()
		}
	}
}

func (r *Runtime) note(level, msg string) {
	r.events.add(Event{At: time.Now(), Level: level, Message: msg})
	r.log.Info(msg, "level", level)
}

// checkHealth marks inputs up or down and applies the backup policy.
func (r *Runtime) checkHealth(now time.Time) {
	for i, in := range r.inputs {
		up := !in.lastData.IsZero() && now.Sub(in.lastData) < in.timeout
		if up == in.up {
			continue
		}
		in.up = up
		if up {
			in.upSince = now
			r.note("info", fmt.Sprintf("Entrada %d: llegan datos", i+1))
		} else {
			r.note("warn", fmt.Sprintf("Entrada %d: sin datos desde hace %d s", i+1, int(in.timeout.Seconds())))
		}
	}
	best := r.firstUsable()
	switch {
	case r.active < 0 || !r.inputs[r.active].up:
		// Nothing active, or the active one fell: take the first that works. If none works, keep the last
		// one: the output keeps its structure (PAT, PMT, clock padding) until something comes back.
		if best >= 0 && best != r.active {
			why := "arranque"
			if r.active >= 0 {
				why = fmt.Sprintf("cayó la entrada %d", r.active+1)
			}
			r.switchTo(best, why)
		}
	case r.svc.Backup.Mode == ModeActive && best >= 0 && best < r.active:
		delay := time.Duration(r.svc.Backup.ReturnDelaySec) * time.Second
		if now.Sub(r.inputs[best].upSince) >= delay {
			r.switchTo(best, fmt.Sprintf("la entrada %d estuvo estable %d s", best+1, r.svc.Backup.ReturnDelaySec))
		}
	}
}

// firstUsable is the lowest input that has data and a program to follow.
func (r *Runtime) firstUsable() int {
	for i, in := range r.inputs {
		if in.up && in.an.Current() != nil {
			return i
		}
	}
	return -1
}

func (r *Runtime) switchTo(idx int, why string) {
	first := r.active < 0
	r.active = idx
	r.stab.SetProgram(r.inputs[idx].an.Current(), !first)
	r.note("info", fmt.Sprintf("Entrada activa: %d (%s). La salida mantiene sus PIDs.", idx+1, why))
}

func (r *Runtime) handle(c command) error {
	switch c.kind {
	case "switch":
		if c.index < 0 || c.index >= len(r.inputs) {
			return fmt.Errorf("input %d does not exist", c.index)
		}
		in := r.inputs[c.index]
		if in.an.Current() == nil {
			return fmt.Errorf("input %d has no program yet", c.index+1)
		}
		if c.index != r.active {
			r.switchTo(c.index, "cambio manual")
		}
		return nil
	case "profile":
		if err := r.stab.SetProfile(c.profile); err != nil {
			return err
		}
		r.svc.Profile = c.profile
		r.note("info", "Perfil de salida actualizado en caliente")
		return nil
	}
	return fmt.Errorf("unknown command")
}

func (r *Runtime) updateRates(now time.Time) {
	if now.Sub(r.rateAt) < rateWindow {
		return
	}
	secs := now.Sub(r.rateAt).Seconds()
	for _, in := range r.inputs {
		in.kbps = float64(in.bytes-in.rateMark) * 8 / 1000 / secs
		in.rateMark = in.bytes
	}
	r.outKbps = float64(r.stab.OutPackets-r.outMark) * ts.PacketSize * 8 / 1000 / secs
	r.outMark = r.stab.OutPackets
	r.rateAt = now
}

func (r *Runtime) snapshot(now time.Time) Status {
	st := Status{
		State: "running", ActiveInput: r.active, UptimeSec: int64(now.Sub(r.startedAt).Seconds()),
		OutKbps: r.outKbps, PMTVersion: r.stab.PMTVersion(), Mapping: r.stab.Mapping(), Events: r.events.list(),
		Inputs: []InputStatus{}, Outputs: []OutputStatus{}, Viewers: r.hub.Viewers(),
	}
	for i, in := range r.inputs {
		st.Inputs = append(st.Inputs, InputStatus{
			Index: i, URL: redactURL(in.cfg.URL), Up: in.up, Active: i == r.active, Kbps: in.kbps,
			CCErrors: in.an.Stats.CCErrors, LastDataMs: sinceMs(in.lastData, now), LastError: in.lastErr, Program: in.an.Current(),
		})
	}
	for i, out := range r.outputs {
		out.mu.Lock()
		st.Outputs = append(st.Outputs, OutputStatus{Index: i, URL: redactURL(out.cfg.URL), Up: out.up, Dropped: out.dropped, LastError: out.lastErr})
		out.mu.Unlock()
	}
	return st
}
