#include <metal_stdlib>
using namespace metal;

struct Camera {
  float2 viewport;
  float2 center;
  float scale;
  int selectedNode;
  int selectedEdge;
  int connectSource;
};

struct Edge {
  uint2 nodes;
  float4 color;
};

struct Raster {
  float4 position [[position]];
  float4 color;
  float2 local;
  float radius;
  float ring;
};

float2 screen(float2 p, constant Camera &c) {
  return (p - c.center) * c.scale + c.viewport * 0.5;
}

float4 clip(float2 p, constant Camera &c) {
  return float4(p.x / c.viewport.x * 2.0 - 1.0, 1.0 - p.y / c.viewport.y * 2.0, 0, 1);
}

vertex Raster graphNode(uint v [[vertex_id]], uint i [[instance_id]],
    const device float2 *positions [[buffer(0)]], const device float4 *colors [[buffer(1)]],
    constant Camera &c [[buffer(2)]]) {
  constexpr float2 corners[] = {float2(-1,-1), float2(1,-1), float2(-1,1),
    float2(1,-1), float2(1,1), float2(-1,1)};
  bool selected = int(i) == c.selectedNode || int(i) == c.connectSource;
  float radius = selected ? 9.0 : 6.0;
  Raster out;
  out.position = clip(screen(positions[i], c) + corners[v] * (radius + 1.0), c);
  out.color = colors[i];
  out.local = corners[v] * (radius + 1.0);
  out.radius = radius;
  out.ring = selected ? 1.0 : 0.0;
  return out;
}

fragment float4 graphDisc(Raster in [[stage_in]]) {
  float d = length(in.local);
  float aa = max(fwidth(d), 0.5);
  float alpha = 1.0 - smoothstep(in.radius - aa, in.radius, d);
  if (in.ring > 0.5) {
    float gap = smoothstep(6.0, 6.0 + aa, d) * (1.0 - smoothstep(7.5 - aa, 7.5, d));
    alpha *= 1.0 - gap;
  }
  return float4(in.color.rgb, in.color.a * alpha);
}

vertex Raster graphEdge(uint v [[vertex_id]], uint i [[instance_id]],
    const device float2 *positions [[buffer(0)]], const device Edge *edges [[buffer(1)]],
    constant Camera &c [[buffer(2)]]) {
  Edge edge = edges[i];
  float2 a = screen(positions[edge.nodes.x], c);
  float2 b = screen(positions[edge.nodes.y], c);
  float dist = distance(a, b);
  float2 direction = (b - a) / max(dist, 0.001);
  float2 normal = float2(-direction.y, direction.x);
  bool selected = int(i) == c.selectedEdge;
  float halfWidth = selected ? 1.1 : 0.5;
  float2 start = a + direction * 7.0;
  float2 end = b - direction * 8.0;
  float2 p;
  if (v < 6) {
    constexpr float2 corners[] = {float2(0,-1), float2(1,-1), float2(0,1),
      float2(1,-1), float2(1,1), float2(0,1)};
    p = mix(start, end, corners[v].x) + normal * corners[v].y * halfWidth;
  } else {
    float arrow = selected ? 6.0 : 4.0;
    p = v == 6 ? end : end - direction * arrow + normal * (v == 7 ? arrow * 0.5 : -arrow * 0.5);
  }
  Raster out;
  out.position = clip(p, c);
  out.color = edge.color;
  if (dist < 20.0) out.color.a = 0;
  out.local = float2(0);
  out.radius = 0;
  out.ring = 0;
  return out;
}

fragment float4 graphLine(Raster in [[stage_in]]) { return in.color; }
