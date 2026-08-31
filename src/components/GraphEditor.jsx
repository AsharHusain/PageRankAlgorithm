import React, { useEffect, useRef, useState } from 'react';
import GraphCanvas from './GraphCanvas.jsx';
import {
  addEdge, addNode, emptyGraph, graphStats, loadDemoGraph,
  moveNode, randomGraph, removeEdge, removeNode,
} from '../data/graphModel.js';

// Interactive directed-graph editor.
//
// Tools:
//   move   drag nodes around; click to select
//   node   click empty canvas to add a node
//   edge   click a source node then a target node
//   erase  click a node or an edge to delete it
//
// The editor only ever produces a graph. Solving it is the backend's job.

const TOOLS = [
  { id: 'move', label: 'Move', hint: 'Drag nodes to rearrange them.' },
  { id: 'node', label: 'Add node', hint: 'Click anywhere on the canvas to place a node.' },
  { id: 'edge', label: 'Add edge', hint: 'Click the source node, then the target node.' },
  { id: 'erase', label: 'Erase', hint: 'Click a node or an edge to delete it.' },
];

const DRAG_THRESHOLD = 3; // px of movement before a click becomes a drag

export default function GraphEditor({ graph, onChange, ranks, threadOf, disabled }) {
  const [tool, setTool] = useState('move');
  const [selected, setSelected] = useState(null);
  const [pendingSource, setPendingSource] = useState(null);
  const [randomSpec, setRandomSpec] = useState({ nodes: 12, edges: 24 });
  const [history, setHistory] = useState([]);
  const dragRef = useRef(null);

  const stats = graphStats(graph);

  // Push the pre-change graph onto the undo stack, then apply the change.
  function commit(next) {
    if (next === graph) return;
    setHistory((h) => [...h.slice(-49), graph]);
    onChange(next);
  }

  function undo() {
    setHistory((h) => {
      if (!h.length) return h;
      onChange(h[h.length - 1]);
      return h.slice(0, -1);
    });
    setSelected(null);
    setPendingSource(null);
  }

  useEffect(() => {
    function onKey(e) {
      if (disabled) return;
      if (e.key === 'Escape') { setPendingSource(null); setSelected(null); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
        const active = document.activeElement;
        if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
        e.preventDefault();
        commit(removeNode(graph, selected));
        setSelected(null);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function handleNodePointerDown(id, pt) {
    if (disabled) return;
    if (tool !== 'move') return;
    const [nx, ny] = graph.positions[id];
    dragRef.current = { id, dx: nx - pt.x, dy: ny - pt.y, moved: false, origin: graph };
  }

  function handlePointerMove(pt) {
    const d = dragRef.current;
    if (!d) return;
    const nx = pt.x + d.dx;
    const ny = pt.y + d.dy;
    if (!d.moved) {
      const [ox, oy] = d.origin.positions[d.id];
      if (Math.hypot(nx - ox, ny - oy) < DRAG_THRESHOLD) return;
      d.moved = true;
    }
    // Live-update without touching the undo stack; one entry is pushed on
    // pointer-up so an entire drag is a single undo step.
    onChange(moveNode(graph, d.id, nx, ny));
  }

  function handlePointerUp() {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved) setHistory((h) => [...h.slice(-49), d.origin]);
  }

  function handleNodeClick(id) {
    if (disabled) return;
    if (dragRef.current?.moved) return;      // that was a drag, not a click

    if (tool === 'erase') {
      commit(removeNode(graph, id));
      if (selected === id) setSelected(null);
      if (pendingSource === id) setPendingSource(null);
      return;
    }
    if (tool === 'edge') {
      if (pendingSource === null) { setPendingSource(id); return; }
      commit(addEdge(graph, pendingSource, id));
      setPendingSource(null);
      return;
    }
    setSelected((s) => (s === id ? null : id));
  }

  function handleEdgeClick(u, v) {
    if (disabled) return;
    if (tool === 'erase') commit(removeEdge(graph, u, v));
  }

  function handleBackgroundClick(pt) {
    if (disabled) return;
    if (tool === 'node') { commit(addNode(graph, pt.x, pt.y)); return; }
    setSelected(null);
    setPendingSource(null);
  }

  const cursor = disabled ? 'wait'
    : tool === 'node' ? 'crosshair'
    : tool === 'erase' ? 'not-allowed'
    : tool === 'edge' ? 'cell'
    : 'default';

  const activeHint = TOOLS.find((t) => t.id === tool)?.hint;

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <div className="toolgroup" role="group" aria-label="Editing tool">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`toolbtn${tool === t.id ? ' active' : ''}`}
              onClick={() => { setTool(t.id); setPendingSource(null); }}
              disabled={disabled}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="toolgroup">
          <button className="btn small" type="button" disabled={disabled}
                  onClick={() => { commit(loadDemoGraph()); setSelected(null); setPendingSource(null); }}>
            Load demo graph
          </button>
          <button className="btn small" type="button" disabled={disabled}
                  onClick={() => { commit(randomGraph(randomSpec.nodes, randomSpec.edges)); setSelected(null); }}>
            Random
          </button>
          <input
            className="mini-input" type="number" min="0" max="200" value={randomSpec.nodes}
            aria-label="Random graph node count" disabled={disabled}
            onChange={(e) => setRandomSpec((s) => ({ ...s, nodes: +e.target.value }))}
          />
          <span className="mini-sep">nodes</span>
          <input
            className="mini-input" type="number" min="0" max="4000" value={randomSpec.edges}
            aria-label="Random graph edge count" disabled={disabled}
            onChange={(e) => setRandomSpec((s) => ({ ...s, edges: +e.target.value }))}
          />
          <span className="mini-sep">edges</span>
        </div>

        <div className="toolgroup">
          <button className="btn small" type="button" onClick={undo}
                  disabled={disabled || !history.length}>
            Undo
          </button>
          <button className="btn small" type="button" disabled={disabled}
                  onClick={() => { commit(emptyGraph()); setSelected(null); setPendingSource(null); }}>
            Clear
          </button>
        </div>
      </div>

      <div className="editor-hint mono small">
        {pendingSource !== null
          ? <>Drawing an edge from node <b>{pendingSource}</b> — click a target node, or press Esc to cancel.</>
          : activeHint}
      </div>

      <GraphCanvas
        graph={graph}
        ranks={ranks}
        threadOf={threadOf}
        interactive={!disabled}
        cursor={cursor}
        selectedNode={selected}
        pendingSource={pendingSource}
        onNodePointerDown={handleNodePointerDown}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onBackgroundClick={handleBackgroundClick}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        emptyHint={'Empty graph — pick "Add node" and click here, or load the demo graph.'}
      />

      <div className="editor-stats mono small">
        <span><b>{stats.nodes}</b> nodes</span>
        <span><b>{stats.edges}</b> edges</span>
        <span className={stats.dangling ? 'warnish' : ''}>
          <b>{stats.dangling}</b> dangling{stats.dangling ? ` (${stats.danglingIds.slice(0, 8).join(', ')}${stats.danglingIds.length > 8 ? '…' : ''})` : ''}
        </span>
        {selected !== null && <span>selected: <b>node {selected}</b></span>}
      </div>
    </div>
  );
}
