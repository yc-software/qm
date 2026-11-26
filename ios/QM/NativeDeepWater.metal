#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// Slow domain-warped currents for the launch loader, ported from the loader lab's "Deep water".
static float qmH21(float2 p) {
  p = fract(p * float2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

static float qmNoise(float2 p) {
  float2 i = floor(p), f = fract(p);
  float2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(qmH21(i), qmH21(i + float2(1, 0)), u.x),
             mix(qmH21(i + float2(0, 1)), qmH21(i + float2(1, 1)), u.x), u.y);
}

static float qmFbm(float2 p) {
  float s = 0.0, a = 0.5;
  float2x2 m = float2x2(float2(1.6, 1.2), float2(-1.2, 1.6));
  for (int i = 0; i < 5; i++) {
    s += a * qmNoise(p);
    p = m * p;
    a *= 0.5;
  }
  return s;
}

[[stitchable]] half4 qmDeepWater(float2 position, half4 color, float2 size, float time,
                                 half4 c0, half4 c1, half4 c2, half4 c3) {
  float2 uv = (position - 0.5 * size) / size.y;
  uv.y = -uv.y;
  float t = time * 0.06;
  float3 C0 = float3(c0.rgb), C1 = float3(c1.rgb), C2 = float3(c2.rgb), C3 = float3(c3.rgb);
  float2 q = float2(qmFbm(uv * 1.1 + float2(0.0, t)), qmFbm(uv * 1.1 + float2(5.2, 1.3) - t));
  float2 r = float2(qmFbm(uv * 1.1 + 3.0 * q + float2(1.7, 9.2) + 0.6 * t),
                    qmFbm(uv * 1.1 + 3.0 * q + float2(8.3, 2.8) - 0.5 * t));
  float f = smoothstep(0.16, 0.48, qmFbm(uv * 1.1 + 3.0 * r));
  float g = smoothstep(0.22, 0.42, r.x);
  float3 c = mix(C0, C1, smoothstep(0.0, 0.45, f));
  c = mix(c, C2, smoothstep(0.4, 0.85, f) * (0.45 + 0.55 * g) * 0.95);
  c = mix(c, C3, smoothstep(0.6, 1.05, f) * g * 0.4);
  c = mix(c, mix(C0, C1, 0.6), smoothstep(0.32, 0.0, length(uv * float2(1.0, 1.9))) * 0.6);
  c += (qmH21(position * 2.0 + fract(time) * 97.0) - 0.5) / 255.0 * 2.2;
  return half4(half3(c), 1.0h);
}
