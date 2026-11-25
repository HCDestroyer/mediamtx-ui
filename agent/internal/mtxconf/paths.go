package mtxconf

import (
	"bytes"
	"errors"
	"fmt"

	"gopkg.in/yaml.v3"
)

// encode writes a mapping node back as the overlay text; an empty overlay is an empty file.
func encode(root *yaml.Node) ([]byte, error) {
	if len(root.Content) == 0 {
		return nil, nil
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		return nil, err
	}
	return buf.Bytes(), enc.Close()
}

func checkName(name string) error {
	if !pathName.MatchString(name) {
		return &InvalidError{Message: fmt.Sprintf("path name %q is not valid", name)}
	}
	return nil
}

// editPaths applies change to the `paths` mapping of the overlay and applies the result through the same
// validation as a manual edit. Comments and the formatting of everything else are kept.
func (m *Manager) editPaths(change func(paths *yaml.Node, inBase func(string) bool) error) error {
	m.mu.Lock()
	overlayText, err := readOptional(m.paths.Overlay)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	baseText, err := readOptional(m.paths.Base)
	m.mu.Unlock()
	if err != nil {
		return err
	}
	root, err := parse(overlayText, "the additional configuration")
	if err != nil {
		return &InvalidError{Message: err.Error()}
	}
	baseKeys := map[string]bool{}
	if base, err := parse(baseText, "the base configuration"); err == nil {
		if at := keyIndex(base, "paths"); at >= 0 && base.Content[at+1].Kind == yaml.MappingNode {
			for i := 0; i+1 < len(base.Content[at+1].Content); i += 2 {
				baseKeys[base.Content[at+1].Content[i].Value] = true
			}
		}
	}

	at := keyIndex(root, "paths")
	if at < 0 || root.Content[at+1].Kind != yaml.MappingNode {
		node := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		if at >= 0 {
			root.Content[at+1] = node
		} else {
			root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "paths"}, node)
			at = len(root.Content) - 2
		}
	}
	paths := root.Content[at+1]
	if err := change(paths, func(n string) bool { return baseKeys[n] }); err != nil {
		return err
	}
	if len(paths.Content) == 0 {
		root.Content = append(root.Content[:at], root.Content[at+2:]...)
	}
	text, err := encode(root)
	if err != nil {
		return err
	}
	return m.Apply(string(text))
}

func confNode(conf map[string]any) (*yaml.Node, error) {
	var n yaml.Node
	if err := n.Encode(conf); err != nil {
		return nil, err
	}
	if n.Kind != yaml.MappingNode {
		return nil, errors.New("a path configuration must be a mapping")
	}
	return &n, nil
}

// SetPath makes the overlay define the path with exactly this configuration (the path was just added).
func (m *Manager) SetPath(name string, conf map[string]any) error {
	if err := checkName(name); err != nil {
		return err
	}
	node, err := confNode(conf)
	if err != nil {
		return &InvalidError{Message: err.Error()}
	}
	return m.editPaths(func(paths *yaml.Node, _ func(string) bool) error {
		prune(node)
		setKey(paths, keyIndex(paths, name), &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name}, node)
		return nil
	})
}

// PatchPath changes some fields of a path, wherever it is defined (the operator's file or the overlay).
func (m *Manager) PatchPath(name string, conf map[string]any) error {
	if err := checkName(name); err != nil {
		return err
	}
	node, err := confNode(conf)
	if err != nil {
		return &InvalidError{Message: err.Error()}
	}
	return m.editPaths(func(paths *yaml.Node, _ func(string) bool) error {
		at := keyIndex(paths, name)
		if at >= 0 && paths.Content[at+1].Kind == yaml.MappingNode {
			mergeNodes(paths.Content[at+1], node)
			return nil
		}
		prune(node)
		setKey(paths, at, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name}, node)
		return nil
	})
}

// RemovePath deletes a path. One that only exists in the overlay is simply dropped; one defined in the
// operator's file gets a null in the overlay, which removes it from the generated file.
func (m *Manager) RemovePath(name string) error {
	if err := checkName(name); err != nil {
		return err
	}
	return m.editPaths(func(paths *yaml.Node, inBase func(string) bool) error {
		at := keyIndex(paths, name)
		if at >= 0 {
			paths.Content = append(paths.Content[:at], paths.Content[at+2:]...)
		}
		if inBase(name) {
			paths.Content = append(paths.Content,
				&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name},
				&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"})
		}
		return nil
	})
}
