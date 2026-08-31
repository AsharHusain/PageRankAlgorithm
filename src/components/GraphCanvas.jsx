import React, { useCallback, useMemo, useRef, useState } from 'react';

// Interactive SVG canvas for a directed graph.
//
// It renders whatever `ranks` it is handed and never computes them. When
// `ranks` is null every node is drawn at the same neutral size, which is
// the honest way to say "this graph has not been solved yet".

export const THREAD_COLORS = [
  '#35bfb0', '#eda94a', '#7aa2f7', '#e06c75', '#c792ea',
  '#98c379', '#56b6c2', '#d19a66', '#f78fb3', '#8ee6c1',
];

const R_MIN = 17;
const R_MAX = 40;
const R_FLAT = 22;

function nodeRadius(rank, min, max) {
  if (rank === undefined || rank === null) return R_FLAT;
  if (!(max > min)) return (R_MIN + R_MAX) / 2;
  // Square-root scaling: area, not radius, tracks the rank, which is how
  // people actually read circle sizes.
  const t = Math.sqrt((rank - min) / (max - min));
  return R_MIN + (R_MAX - R_MIN) * t;
}

function rankColor(rank, min, max) {
  if (rank === undefined || rank === null) return '#33455e';
  const t = max > min ? (rank - min) / (max - min) : 0.5;
  const lo = [26, 74, 88];
  const hi = [53, 191, 176];
  const c = lo.map((l, i) => Math.round(l + (hi[i] - l) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Convert a browser pointer event into SVG user-space coordinates. */
export function toSvgPoint(svg, evt) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const inv = ctm.inverse();
  const x = evt.clientX * inv.a + evt.clientY * inv.c + inv.e;
  const y = evt.clientX * inv.b + evt.clientY * inv.d + inv.f;
  return { x, y };
}

export default function GraphCanvas({
  graph,
  ranks = null,               // number[] aligned to graph.nodeIds, from C
  threadOf = null,            // number[] aligned to graph.nodeIds, from C
  width = 900,
  height = 520,
  selectedNode = null,
  pendingSource = null,       // edge tool: the node we are drawing from
  highlightNodes = null,
  onNodePointerDown,
  onNodeClick,
  onEdgeClick,
  onBackgroundClick,
  onPointerMove,
  onPointerUp,
  cursor = 'default',
  interactive = false,
  showRankLabels = true,
  emptyHint = 'No nodes yet.',
}) {
  const svgRef = useRef(null);
  const [hovered, setHovered] = useState(null);
  const [hoveredEdge, setHoveredEdge] = useState(null);

  const { nodeIds, edges, positions } = graph;

  const rankByNode = useMemo(() => {
    if (!ranks) return null;
    const m = new Map();
    nodeIds.forEach((id, i) => m.set(id, ranks[i]));
    return m;
  }, [ranks, nodeIds]);

  const threadByNode = useMemo(() => {
    if (!threadOf) return null;
    const m = new Map();
    nodeIds.forEach((id, i) => m.set(id, threadOf[i]));
    return m;
  }, [threadOf, nodeIds]);

  const [minRank, maxRank] = useMemo(() => {
    if (!ranks || !ranks.length) return [0, 0];
    return [Math.min(...ranks), Math.max(...ranks)];
  }, [ranks]);

  // Rank position (1 = highest) for the badge on each node.
  const rankOrder = useMemo(() => {
    if (!rankByNode) return null;
    const sorted = [...nodeIds].sort((a, b) => rankByNode.get(b) - rankByNode.get(a));
    const m = new Map();
    sorted.forEach((id, i) => m.set(id, i + 1));
    return m;
  }, [rankByNode, nodeIds]);

  const radiusOf = useCallback(
    (id) => nodeRadius(rankByNode?.get(id), minRank, maxRank),
    [rankByNode, minRank, maxRank],
  );

  const reciprocal = useMemo(() => {
    const s = new Set(edges.map(([u, v]) => `${u}>${v}`));
    return (u, v) => s.has(`${v}>${u}`);
  }, [edges]);

  // Edge geometry: trimmed at both ends so the arrowhead lands on the rim
  // of the target circle rather than at its centre.
  function edgeGeometry(u, v) {
    const p1 = positions[u];
    const p2 = positions[v];
    if (!p1 || !p2) return null;
    const r1 = radiusOf(u);
    const r2 = radiusOf(v);

    if (u === v) {
      // Self-loop: a small circle sitting above the node.
      const [x, y] = p1;
      const lr = r1 * 0.85;
      return {
        d: `M ${x - r1 * 0.5} ${y - r1 * 0.75} A ${lr} ${lr} 0 1 1 ${x + r1 * 0.5} ${y - r1 * 0.75}`,
        mid: [x, y - r1 - lr * 1.1],
      };
    }

    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;

    if (reciprocal(u, v)) {
      // Bow the two directions apart so both remain visible.
      const off = 22;
      const nx = -uy;
      const ny = ux;
      const cx = (p1[0] + p2[0]) / 2 + nx * off;
      const cy = (p1[1] + p2[1]) / 2 + ny * off;
      // Trim toward the control point so the curve starts/ends on the rims.
      const a1 = Math.atan2(cy - p1[1], cx - p1[0]);
      const a2 = Math.atan2(cy - p2[1], cx - p2[0]);
      const sx = p1[0] + Math.cos(a1) * r1;
      const sy = p1[1] + Math.sin(a1) * r1;
      const ex = p2[0] + Math.cos(a2) * (r2 + 7);
      const ey = p2[1] + Math.sin(a2) * (r2 + 7);
      return { d: `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`, mid: [cx, cy] };
    }

    const sx = p1[0] + ux * r1;
    const sy = p1[1] + uy * r1;
    const ex = p2[0] - ux * (r2 + 7);
    const ey = p2[1] - uy * (r2 + 7);
    return { d: `M ${sx} ${sy} L ${ex} ${ey}`, mid: [(sx + ex) / 2, (sy + ey) / 2] };
  }

  const highlight = highlightNodes ? new Set(highlightNodes) : null;

  function nodeFill(id) {
    if (threadByNode && threadByNode.get(id) !== undefined) {
      return THREAD_COLORS[threadByNode.get(id) % THREAD_COLORS.length];
    }
    return rankColor(rankByNode?.get(id), minRank, maxRank);
  }

  function handleBackground(e) {
    if (e.target === svgRef.current || e.target.dataset.bg === '1') {
      onBackgroundClick?.(toSvgPoint(svgRef.current, e), e);
    }
  }

  return (
    <div className="graphcanvas">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="graphcanvas-svg"
        style={{ cursor }}
        role="img"
        aria-label="Directed graph editor"
        onClick={handleBackground}
        onPointerMove={(e) => onPointerMove?.(toSvgPoint(svgRef.current, e), e)}
        onPointerUp={(e) => onPointerUp?.(toSvgPoint(svgRef.current, e), e)}
        onPointerLeave={(e) => onPointerUp?.(toSvgPoint(svgRef.current, e), e)}
      >
        <defs>
          <marker id="gc-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#54687f" />
          </marker>
          <marker id="gc-arrow-hi" viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#eda94a" />
          </marker>
        </defs>

        <rect data-bg="1" x="0" y="0" width={width} height={height} fill="transparent" />

        {/* ---- edges ---- */}
        <g>
          {edges.map(([u, v], i) => {
            const geo = edgeGeometry(u, v);
            if (!geo) return null;
            const touchesHover = hovered !== null && (hovered === u || hovered === v);
            const isHovered = hoveredEdge === i;
            const dim = hovered !== null && !touchesHover;
            return (
              <g key={`${u}-${v}-${i}`}>
                <path
                  d={geo.d}
                  className={`gc-edge${touchesHover || isHovered ? ' hi' : ''}`}
                  style={{ opacity: dim ? 0.2 : 1 }}
                  markerEnd={`url(#${touchesHover || isHovered ? 'gc-arrow-hi' : 'gc-arrow'})`}
                />
                {onEdgeClick && (
                  // Invisible fat stroke: makes thin edges easy to click.
                  <path
                    d={geo.d}
                    className="gc-edge-hit"
                    onMouseEnter={() => setHoveredEdge(i)}
                    onMouseLeave={() => setHoveredEdge(null)}
                    onClick={(e) => { e.stopPropagation(); onEdgeClick(u, v, e); }}
                  />
                )}
              </g>
            );
          })}
        </g>

        {/* ---- in-progress edge preview ---- */}
        {pendingSource !== null && positions[pendingSource] && (
          <circle
            cx={positions[pendingSource][0]}
            cy={positions[pendingSource][1]}
            r={radiusOf(pendingSource) + 7}
            className="gc-pending-ring"
          />
        )}

        {/* ---- nodes ---- */}
        <g>
          {nodeIds.map((id) => {
            const pos = positions[id];
            if (!pos) return null;
            const [x, y] = pos;
            const r = radiusOf(id);
            const rank = rankByNode?.get(id);
            const isSel = selectedNode === id;
            const isHi = !highlight || highlight.has(id);
            return (
              <g
                key={id}
                className="gc-node"
                style={{ opacity: isHi ? 1 : 0.28, cursor: interactive ? 'pointer' : 'default' }}
                onPointerDown={(e) => { e.stopPropagation(); onNodePointerDown?.(id, toSvgPoint(svgRef.current, e), e); }}
                onClick={(e) => { e.stopPropagation(); onNodeClick?.(id, e); }}
                onMouseEnter={() => setHovered(id)}
                onMouseLeave={() => setHovered(null)}
              >
                {isSel && <circle cx={x} cy={y} r={r + 6} className="gc-select-ring" />}
                <circle
                  cx={x} cy={y} r={r}
                  fill={nodeFill(id)}
                  stroke={hovered === id ? '#e9edf3' : '#0a0f19'}
                  strokeWidth={3}
                  style={{ transition: 'r .35s cubic-bezier(.2,.7,.3,1), fill .35s ease' }}
                />
                <text x={x} y={y + 5} textAnchor="middle" className="gc-node-id"
                      fontSize={Math.max(12, r * 0.6)}>
                  {id}
                </text>
                {showRankLabels && rank !== undefined && rank !== null && (
                  <text x={x} y={y + r + 15} textAnchor="middle" className="gc-node-rank">
                    {rank.toFixed(4)}
                  </text>
                )}
                {rankOrder && (
                  <g>
                    <circle cx={x + r * 0.72} cy={y - r * 0.72} r={9} className="gc-rank-badge" />
                    <text x={x + r * 0.72} y={y - r * 0.72 + 3.5} textAnchor="middle"
                          className="gc-rank-badge-text">
                      {rankOrder.get(id)}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>

        {!nodeIds.length && (
          <text x={width / 2} y={height / 2} textAnchor="middle" className="gc-empty">
            {emptyHint}
          </text>
        )}
      </svg>

      <div className="gc-status mono small">
        {hovered !== null ? (
          <>
            Node <b>{hovered}</b>
            {rankByNode?.get(hovered) !== undefined && <> · PR = {rankByNode.get(hovered).toFixed(6)}</>}
            {rankOrder && <> · rank #{rankOrder.get(hovered)}</>}
            {threadByNode?.get(hovered) !== undefined && <> · thread {threadByNode.get(hovered)}</>}
          </>
        ) : (
          <>Nodes: <b>{nodeIds.length}</b> · Edges: <b>{edges.length}</b>
            {ranks ? ' · size and shade encode the PageRank returned by C' : ' · not solved yet'}</>
        )}
      </div>
    </div>
  );
}
