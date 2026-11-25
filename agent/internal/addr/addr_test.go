package addr

import "testing"

func TestParse(t *testing.T) {
	a, err := Parse("udp://eth0@239.255.1.1:1234#pnr=100&timeout=5")
	if err != nil {
		t.Fatal(err)
	}
	if a.Scheme != "udp" || a.Rest != "eth0@239.255.1.1:1234" || a.Options["pnr"] != "100" || a.Options["timeout"] != "5" {
		t.Fatalf("unexpected: %+v", a)
	}
	if a.WithoutOptions() != "udp://eth0@239.255.1.1:1234" {
		t.Fatalf("WithoutOptions = %q", a.WithoutOptions())
	}
	if n, err := a.Int("pnr", 0); n != 100 || err != nil {
		t.Fatal("Int")
	}
	if n, _ := a.Int("missing", 7); n != 7 {
		t.Fatal("default")
	}
	if _, err := a.Int("pnr", 0); err != nil {
		t.Fatal(err)
	}
	b, _ := Parse("udp://1.2.3.4:5#x=abc")
	if _, err := b.Int("x", 0); err == nil {
		t.Fatal("expected an error for a non-numeric option")
	}
}

func TestParseRejectsMalformed(t *testing.T) {
	for _, bad := range []string{"", "udp", "udp://", "://host", "udp://h#=1", "no scheme"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestParseUDP(t *testing.T) {
	cases := []struct {
		in    string
		iface string
		ip    string
		port  int
		mc    bool
	}{
		{"udp://239.255.1.1:5000", "", "239.255.1.1", 5000, true},
		{"udp://eth0@239.255.1.1:5000", "eth0", "239.255.1.1", 5000, true},
		{"udp://192.168.1.5:1234", "", "192.168.1.5", 1234, false},
		{"udp://239.255.1.1", "", "239.255.1.1", 1234, true},
		{"udp://@:1234", "", "0.0.0.0", 1234, false},
		{"udp://127.0.0.1:9", "", "127.0.0.1", 9, false},
	}
	for _, c := range cases {
		a, err := Parse(c.in)
		if err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		u, err := ParseUDP(a)
		if err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		if u.Interface != c.iface || u.IP.String() != c.ip || u.Port != c.port || u.Multicast() != c.mc {
			t.Errorf("%s: got %+v", c.in, u)
		}
	}
	for _, bad := range []string{"udp://notanip:1234", "udp://1.2.3.4:0", "udp://1.2.3.4:99999"} {
		a, _ := Parse(bad)
		if _, err := ParseUDP(a); err == nil {
			t.Errorf("%s should fail", bad)
		}
	}
}
