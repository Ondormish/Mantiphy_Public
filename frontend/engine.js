/* Mantiphy render engine — WebGL2, non-destructive.
   Pipeline:  source ─► base (WB, exposure, tone, curve, HSL, grading, presence)
                        ─► for each mask: maskTex ─► local adjustments mixed by mask
                        ─► final (crop/rotate/flip, sharpen, vignette, grain, overlays) ─► screen / pixels */

const GLSL_COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;
const float EPS = 1e-5;
vec3 s2l(vec3 c){ return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045, c)); }
vec3 l2s(vec3 c){ c = max(c, 0.0); return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4))-0.055, step(0.0031308, c)); }
// Soft-knee highlight roll-off in linear light: values above 'knee' compress smoothly
// toward 'ceil' instead of clipping hard at 1.0 once exposure pushes them up.
vec3 highlightRolloff(vec3 c, float knee, float ceiling){
  vec3 e = max(c - knee, 0.0);
  float r = ceiling - knee;
  return c - e + r * (1.0 - exp(-e / r));
}
float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsv(vec3 c){ vec4 K=vec4(0.,-1./3.,2./3.,-1.); vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g)); vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r)); float d=q.x-min(q.w,q.y); return vec3(abs(q.z+(q.w-q.y)/(6.*d+EPS)), d/(q.x+EPS), q.x); }
vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx, clamp(p-K.xxx,0.,1.), c.y); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }

// White balance gains (temp/tint in -1..1) applied in linear
vec3 wbGains(float temp, float tint){
  vec3 g = vec3(1.0 + temp*0.45, 1.0 + tint*0.25, 1.0 - temp*0.45);
  g.g -= tint*0.0; g.r -= tint*0.12; g.b -= tint*0.12;
  return g / lum(g);
}
// Tone region adjustments on perceptual (sRGB-encoded) values
vec3 toneRegions(vec3 p, float hi, float sh, float wh, float bl){
  float L = lum(p);
  float wH = smoothstep(0.35, 1.0, L);
  float wS = 1.0 - smoothstep(0.05, 0.65, L);
  float wW = smoothstep(0.5, 1.0, L);
  float wB = 1.0 - smoothstep(0.0, 0.45, L);
  float d = 0.0;
  d += hi * 0.32 * wH * (1.0 - L*L*0.8);
  d += sh * 0.30 * wS * (sqrt(max(L,0.0)) + 0.12);
  d += wh * 0.22 * wW;
  d += bl * 0.22 * wB;
  // scale chroma-preserving, with additive fallback near black
  float Ln = max(L + d, 0.0);
  vec3 scaled = p * (Ln / max(L, 0.02));
  return mix(p + d, scaled, smoothstep(0.0, 0.08, L));
}
vec3 contrastOp(vec3 p, float ct){
  if (ct > 0.0){
    float k = 1.0 + ct*2.2;
    vec3 s = 0.5 + 0.5*tanh(k*(p-0.5)*1.6)/tanh(k*0.8);
    return mix(p, s, min(ct*1.5, 1.0));
  }
  return 0.5 + (p-0.5)*(1.0 + ct*0.6);
}
vec3 saturationOp(vec3 p, float vib, float sat){
  vec3 hsv = rgb2hsv(p);
  float skin = 1.0 - smoothstep(0.03, 0.12, abs(hsv.x - 0.07)); // protect oranges
  float s = hsv.y;
  s = s + vib * (1.0 - s) * s * 1.8 * (1.0 - skin*0.6);
  s *= (1.0 + sat);
  hsv.y = clamp(s, 0.0, 1.0);
  return hsv2rgb(hsv);
}
// "Color enhancer": pushes already-vivid colors further (opposite curve from vibrance's
// low-saturation protection), for a punchy/product-photo look without touching neutrals.
vec3 colorEnhanceOp(vec3 p, float amt){
  if (amt == 0.0) return p;
  vec3 hsv = rgb2hsv(p);
  float s = hsv.y;
  hsv.y = clamp(s + amt * s * s * 1.3, 0.0, 1.0);
  return hsv2rgb(hsv);
}
`;

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS_BASE = GLSL_COMMON + `
uniform sampler2D uSrc, uBlurS, uBlurL, uCurve, uDenoised;
uniform float uTemp, uTint, uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTexture, uClarity, uDehaze, uVibrance, uSaturation;
uniform float uDenoiseAmount, uDenoiseDetail, uNoiseSigma;
uniform float uColorEnhance, uDynamicContrast;
uniform float uHslHue[8], uHslSat[8], uHslLum[8];
uniform vec3 uGradeSh, uGradeMid, uGradeHi; // hue(0..1), sat(0..1), lum(-1..1)
uniform float uGradeBlend, uGradeBalance;
uniform int uHasCurve;
uniform mat3 uCameraMatrix;
uniform int uLensVigOn; uniform vec3 uLensVigTerms; uniform float uLensVigAmount, uLensScale, uAspect;
in vec2 vUv; out vec4 outColor;

float bandWeight(float h, float center){ float d = abs(fract(h - center + 0.5) - 0.5); return 1.0 - smoothstep(0.0, 1.0/12.0, d); }
vec3 hslOp(vec3 p){
  vec3 hsv = rgb2hsv(p);
  const float centers[8] = float[8](0.0, 30./360., 60./360., 120./360., 180./360., 240./360., 275./360., 315./360.);
  float dh = 0.0, ds = 0.0, dl = 0.0, wsum = 0.0;
  for (int i=0;i<8;i++){ float w = bandWeight(hsv.x, centers[i]); dh += w*uHslHue[i]; ds += w*uHslSat[i]; dl += w*uHslLum[i]; wsum += w; }
  float chroma = smoothstep(0.0, 0.25, hsv.y);
  hsv.x = fract(hsv.x + dh * (30.0/360.0) * chroma);
  hsv.y = clamp(hsv.y * (1.0 + ds), 0.0, 1.0);
  vec3 c = hsv2rgb(hsv);
  float L = lum(c);
  c *= (1.0 + dl * 0.6 * chroma * (dl > 0.0 ? (1.0 - L) : L) );
  return c;
}
vec3 gradeOp(vec3 p){
  float L = lum(p);
  float bal = uGradeBalance*0.25;
  float soft = mix(0.08, 0.45, uGradeBlend);
  float wS = 1.0 - smoothstep(0.25 + bal - soft, 0.25 + bal + soft, L);
  float wH = smoothstep(0.65 + bal - soft, 0.65 + bal + soft, L);
  float wM = clamp(1.0 - wS - wH, 0.0, 1.0);
  vec3 tS = hsv2rgb(vec3(uGradeSh.x, 1.0, 1.0)) - 0.5;
  vec3 tM = hsv2rgb(vec3(uGradeMid.x, 1.0, 1.0)) - 0.5;
  vec3 tH = hsv2rgb(vec3(uGradeHi.x, 1.0, 1.0)) - 0.5;
  p += wS * (tS * uGradeSh.y * 0.35 + uGradeSh.z * 0.25);
  p += wM * (tM * uGradeMid.y * 0.30 + uGradeMid.z * 0.25);
  p += wH * (tH * uGradeHi.y * 0.35 + uGradeHi.z * 0.25);
  return p;
}
void main(){
  vec3 orig = texture(uSrc, vUv).rgb, den = texture(uDenoised, vUv).rgb;
  vec3 src = mix(orig, den, uDenoiseAmount);
  if (uDenoiseDetail > 0.0 && uDenoiseAmount > 0.0){
    // Give back the texture the denoiser smoothed away (feathers, fur, foliage),
    // luminance only, with coring against this photo's own measured noise level:
    // differences within ~2.5 sigma (Detail 0) down to ~1.3 sigma (Detail 100)
    // are noise and stay removed; real structure above that comes back.
    float d = lum(orig) - lum(den);
    float core = max(uNoiseSigma, 0.004) * mix(2.5, 1.3, uDenoiseDetail);
    float kept = sign(d) * max(abs(d) - core, 0.0);
    src += kept * uDenoiseDetail * uDenoiseAmount;
  }
  vec3 lin = s2l(src);
  // lensfun vignetting (PA model). It describes how the lens darkens linear light, with
  // the radius normalised to the half-diagonal of the calibration sensor — so it is
  // undone here, on scene-linear values in sensor (image) coordinates, before any
  // tonal edit. The gain is capped at 3 stops: profiles extrapolate wildly outside
  // their calibrated range and a runaway gain turns the corners white.
  if (uLensVigOn == 1){
    vec2 d = vUv - 0.5; d.x *= uAspect;
    float Rd = length(d) / (0.5 * sqrt(uAspect*uAspect + 1.0)) * uLensScale;
    float R2 = Rd*Rd;
    float f = 1.0 + uLensVigTerms.x*R2 + uLensVigTerms.y*R2*R2 + uLensVigTerms.z*R2*R2*R2;
    float gain = clamp(1.0 / max(f, 0.125), 1.0/8.0, 8.0);
    lin *= pow(gain, uLensVigAmount);
  }
  lin *= wbGains(uTemp, uTint);
  lin = uCameraMatrix * lin;
  lin *= exp2(uExposure);
  lin = highlightRolloff(lin, 0.65, 2.5);
  vec3 p = l2s(lin);
  p = toneRegions(p, uHighlights, uShadows, uWhites, uBlacks);
  p = contrastOp(p, uContrast);
  // presence: texture (fine), clarity (mid), dehaze
  float Ls = lum(src);
  float bS = texture(uBlurS, vUv).r, bL = texture(uBlurL, vUv).r;
  float L = lum(p);
  float midW = 1.0 - abs(L*2.0-1.0); midW = smoothstep(0.0, 0.6, midW);
  float detailF = (Ls - bS), detailC = (Ls - bL);
  p += detailF * uTexture * 1.4;
  p += detailC * uClarity * 1.2 * (0.4 + 0.6*midW);
  if (uDehaze > 0.0){
    float haze = smoothstep(0.35, 0.9, bL) * (1.0 - smoothstep(0.0, 0.25, abs(detailC)*4.0));
    float a = uDehaze * 0.45 * haze;
    p = clamp((p - a) / (1.0 - a*0.9), 0.0, 1.0);
    p = saturationOp(p, 0.0, uDehaze*0.25*haze);
  } else if (uDehaze < 0.0){
    p = mix(p, vec3(0.82, 0.84, 0.88), -uDehaze * 0.35);
  }
  if (uDynamicContrast != 0.0){
    // multi-scale local contrast (fine + mid detail combined), reusing the same blur textures
    float dc = detailF * 0.7 + detailC * 1.1;
    p += dc * uDynamicContrast * 1.3 * (0.5 + 0.5*midW);
    p = saturationOp(clamp(p, 0.0, 1.0), 0.0, uDynamicContrast * 0.15);
  }
  if (uHasCurve == 1){
    float a = texture(uCurve, vec2(p.r, 0.5)).a; p.r = a;
    a = texture(uCurve, vec2(p.g, 0.5)).a; p.g = a;
    a = texture(uCurve, vec2(p.b, 0.5)).a; p.b = a;
    p.r = texture(uCurve, vec2(p.r, 0.5)).r;
    p.g = texture(uCurve, vec2(p.g, 0.5)).g;
    p.b = texture(uCurve, vec2(p.b, 0.5)).b;
  }
  p = hslOp(clamp(p, 0.0, 1.0));
  p = gradeOp(p);
  p = saturationOp(clamp(p, 0.0, 1.0), uVibrance, uSaturation);
  p = colorEnhanceOp(clamp(p, 0.0, 1.0), uColorEnhance);
  outColor = vec4(clamp(p, 0.0, 1.0), 1.0);
}`;

// Renders one mask (geometry + range + invert) into an R channel texture
const FS_MASK = GLSL_COMMON + `
uniform sampler2D uBase, uTex;
uniform int uType;            // 0 linear, 1 radial, 2 texture (brush / AI), 3 whole image
uniform vec4 uP;              // linear: x0,y0,x1,y1 ; radial: cx,cy,rx,ry
uniform vec2 uQ;              // radial: angle, feather
uniform float uAspect;        // image w/h
uniform int uInvert, uRangeOn;
uniform vec4 uRange;          // lo, hi, smooth, 0
uniform int uColorRangeOn; uniform vec4 uColorRange; // h, s, v, tolerance
uniform sampler2D uRefine;    // r = painted-in (add), g = painted-out (subtract)
uniform int uRefineOn;
uniform float uEdgeShift, uEdgeSoft; // texture masks: -1..1 contract/expand, 0..1 softness
in vec2 vUv; out vec4 outColor;
// Soften and/or move the edge of a painted or AI mask: blur it over a disc, then
// re-threshold around a shifted level. Positive shift grows the mask, negative shrinks it.
float edgeOp(float m0){
  float rad = max(uEdgeSoft, abs(uEdgeShift)) * 0.04;          // fraction of image height
  float acc = m0, wsum = 1.0;
  const float GA = 2.39996323;                                  // golden angle
  for (int i = 1; i < 24; i++){
    float fi = float(i); float r = sqrt(fi / 23.0) * rad;
    vec2 o = vec2(cos(fi*GA) / uAspect, sin(fi*GA)) * r;
    acc += texture(uTex, vUv + o).r; wsum += 1.0;
  }
  float b = acc / wsum;
  float c = 0.5 - uEdgeShift * 0.4, w = 0.04 + 0.46 * uEdgeSoft;
  return smoothstep(c - w, c + w, b);
}
void main(){
  float m = 1.0;
  vec2 uv = vUv; // texture v == image y-down (textures are uploaded top row first)
  if (uType == 0){
    vec2 a = uP.xy, b = uP.zw; vec2 d = b - a; d.x *= uAspect; vec2 r = uv - a; r.x *= uAspect;
    float len = max(length(d), EPS);
    float t = dot(r, d/len)/len;
    m = 1.0 - smoothstep(0.0, 1.0, t);
  } else if (uType == 1){
    vec2 r = uv - uP.xy; r.x *= uAspect;
    float c = cos(-uQ.x), s = sin(-uQ.x);
    r = vec2(r.x*c - r.y*s, r.x*s + r.y*c);
    vec2 rad = vec2(uP.z*uAspect, uP.w);
    float dist = length(r / max(rad, vec2(EPS)));
    float f = clamp(uQ.y, 0.01, 1.0);
    m = 1.0 - smoothstep(1.0 - f, 1.0 + f*0.15, dist);
  } else if (uType == 3){
    m = 1.0;
  } else {
    m = texture(uTex, vUv).r;
    if (uEdgeShift != 0.0 || uEdgeSoft > 0.0) m = edgeOp(m);
  }
  if (uRangeOn == 1 || uColorRangeOn == 1){
    vec3 c = texture(uBase, vUv).rgb;
    if (uRangeOn == 1){
      float L = lum(c); float s = max(uRange.z, 0.005);
      float w = smoothstep(uRange.x - s, uRange.x + s*0.2, L) * (1.0 - smoothstep(uRange.y - s*0.2, uRange.y + s, L));
      m *= w;
    }
    if (uColorRangeOn == 1){
      vec3 hsv = rgb2hsv(c);
      float dh = abs(fract(hsv.x - uColorRange.x + 0.5) - 0.5);
      float d = sqrt(dh*dh*6.0 + pow(hsv.y - uColorRange.y, 2.0)*1.5 + pow(hsv.z - uColorRange.z, 2.0)*0.6);
      m *= 1.0 - smoothstep(uColorRange.w*0.5, uColorRange.w*1.5 + 0.02, d);
    }
  }
  if (uInvert == 1) m = 1.0 - m;
  if (uRefineOn == 1){
    vec2 rg = texture(uRefine, vUv).rg;
    m = max(m, rg.r);          // painted in: union
    m = m * (1.0 - rg.g);      // painted out: subtract, wins over both the base mask and additions
  }
  outColor = vec4(m, m, m, 1.0);
}`;

const FS_LOCAL = GLSL_COMMON + `
uniform sampler2D uIn, uMask, uBlurL, uBlurS, uSrc;
uniform float uTemp, uTint, uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks, uSaturation, uClarity, uDehaze, uAmount;
uniform float uTexture, uSharpness; uniform vec2 uTexel;
in vec2 vUv; out vec4 outColor;
void main(){
  vec3 p0 = texture(uIn, vUv).rgb;
  float m = texture(uMask, vUv).r * uAmount;
  if (m <= 0.001){ outColor = vec4(p0, 1.0); return; }
  vec3 lin = s2l(p0) * wbGains(uTemp, uTint) * exp2(uExposure);
  lin = highlightRolloff(lin, 0.65, 2.5);
  vec3 p = l2s(lin);
  p = toneRegions(p, uHighlights, uShadows, uWhites, uBlacks);
  p = contrastOp(p, uContrast);
  float Ls = lum(texture(uSrc, vUv).rgb); float bL = texture(uBlurL, vUv).r;
  p += (Ls - bL) * uClarity * 1.2;
  if (uTexture != 0.0) p += (Ls - texture(uBlurS, vUv).r) * uTexture * 1.4;
  if (uSharpness != 0.0){
    // local sharpening (e.g. on a Subject mask): luminance unsharp mask of the
    // working image at ~1px, capped to keep halos in check
    float L0 = lum(p0);
    float b = (lum(texture(uIn, vUv + vec2(uTexel.x,0.)).rgb) + lum(texture(uIn, vUv - vec2(uTexel.x,0.)).rgb)
             + lum(texture(uIn, vUv + vec2(0.,uTexel.y)).rgb) + lum(texture(uIn, vUv - vec2(0.,uTexel.y)).rgb)) * 0.25;
    p += clamp(L0 - b, -0.12, 0.12) * uSharpness * 2.5;
  }
  if (uDehaze > 0.0){ float a = uDehaze*0.35*smoothstep(0.3,0.9,bL); p = clamp((p - a)/(1.0 - a*0.9), 0.0, 1.0); }
  else if (uDehaze < 0.0){ p = mix(p, vec3(0.85), -uDehaze*0.3); }
  p = saturationOp(clamp(p,0.0,1.0), 0.0, uSaturation);
  outColor = vec4(mix(p0, clamp(p,0.0,1.0), m), 1.0);
}`;

const FS_SKY = GLSL_COMMON + `
uniform sampler2D uIn, uMask, uSky;
uniform float uSkyScale, uSkyOffX, uSkyOffY, uSkyFlip;
in vec2 vUv; out vec4 outColor;
void main(){
  vec3 p0 = texture(uIn, vUv).rgb;
  float m = texture(uMask, vUv).r;
  if (m <= 0.001){ outColor = vec4(p0, 1.0); return; }
  vec2 uv = (vUv - 0.5) / max(uSkyScale, 0.01) + 0.5 - vec2(uSkyOffX, uSkyOffY);
  uv.x = mix(uv.x, 1.0 - uv.x, uSkyFlip);
  vec3 sky = texture(uSky, clamp(uv, 0.0, 1.0)).rgb;
  outColor = vec4(mix(p0, sky, m), 1.0);
}`;

const FS_BLUR = GLSL_COMMON + `
uniform sampler2D uTex; uniform vec2 uDir; uniform int uLum;
in vec2 vUv; out vec4 outColor;
void main(){
  float w[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 acc = texture(uTex, vUv).rgb * w[0];
  for (int i=1;i<5;i++){ acc += texture(uTex, vUv + uDir*float(i)).rgb*w[i]; acc += texture(uTex, vUv - uDir*float(i)).rgb*w[i]; }
  if (uLum == 1) acc = vec3(lum(acc));
  outColor = vec4(acc, 1.0);
}`;

const FS_FINAL = GLSL_COMMON + `
uniform sampler2D uIn, uSrc, uMaskViz, uGlow;
uniform vec2 uTexel;           // 1/size of uIn
uniform vec2 uOutSize;         // output pixel size
uniform vec4 uCrop;            // x,y,w,h in image uv (0..1), y down
uniform float uAngle, uAspect; // radians, image w/h
uniform vec2 uFlip;            // 1 or -1
uniform vec4 uView;            // pan x, pan y (pixels), scale x, scale y (crop-uv -> pixels)
uniform int uCropMode, uBefore, uClip, uShowMask, uGrid;
uniform float uSharpen, uSharpRadius, uSharpMask, uSharpDetail;
uniform float uVignette, uVigMid, uVigFeather, uVigRound, uGrain, uGrainSize;
uniform float uLensVig, uLensDist;
uniform int uLensProfileOn, uLensProfileDistModel;
uniform vec3 uLensProfileDistTerms;
uniform float uLensScale;
uniform float uGlowAmount, uGlowThreshold, uGlowWarmth;
uniform vec2 uFlareP; uniform float uFlareAmt, uFlareSize, uFlareWarmth;
in vec2 vUv; out vec4 outColor;

vec2 rot(vec2 v, float a){ float c=cos(a), s=sin(a); return vec2(v.x*c - v.y*s, v.x*s + v.y*c); }
// crop uv (0..1 within crop) -> image uv (y down)
vec2 cropToImage(vec2 cuv){
  vec2 pImg = uCrop.xy + cuv*uCrop.zw;            // rect in rotated-image space
  vec2 d = pImg - 0.5; d.x *= uAspect;
  d = rot(d, uAngle); d.x /= uAspect;
  vec2 uv = 0.5 + d;
  uv = (uv - 0.5) * uFlip + 0.5;
  return uv;
}
vec3 sampleAt(vec2 iuv){ return texture(uIn, iuv).rgb; }
// Capture sharpening: unsharp mask on luminance only (so colour noise is never
// amplified), over a 3x3 Gaussian ring at the chosen radius. Detail caps the
// high-pass so strong edges don't ring (low Detail = halo-free, high = crisp
// fine texture). Masking restricts it to real edges, found from the gradient at
// twice the radius — a scale where sensor noise has mostly averaged out.
float Ls(vec2 uv){ return lum(texture(uIn, uv).rgb); }
vec3 sharpenLuma(vec2 uv, vec3 c){
  vec2 t = uTexel * uSharpRadius;
  float L0 = lum(c);
  float ring = Ls(uv + vec2(t.x,0.)) + Ls(uv - vec2(t.x,0.)) + Ls(uv + vec2(0.,t.y)) + Ls(uv - vec2(0.,t.y));
  float diag = Ls(uv + t) + Ls(uv - t) + Ls(uv + vec2(t.x,-t.y)) + Ls(uv + vec2(-t.x,t.y));
  float blur = L0*0.25 + ring*0.125 + diag*0.0625;
  float hp = L0 - blur;
  float cap = mix(0.02, 0.2, uSharpDetail);
  hp = clamp(hp, -cap, cap);
  float gx = Ls(uv + vec2(2.0*t.x,0.)) - Ls(uv - vec2(2.0*t.x,0.));
  float gy = Ls(uv + vec2(0.,2.0*t.y)) - Ls(uv - vec2(0.,2.0*t.y));
  float edge = smoothstep(uSharpMask*0.06, uSharpMask*0.06 + 0.03, length(vec2(gx, gy)));
  float k = uSharpen * 2.2 * mix(1.0, edge, uSharpMask);
  return vec3(hp * k);
}
// Rd: distance from center, normalized so Rd=1 at half the image's shorter
// dimension (lensfun's calibration radius). model: 1=poly3, 2=poly5, 3=ptlens.
float lensfunDistortionRatio(int model, vec3 t, float Rd){
  if (model == 1) return 1.0 - t.x + t.x*Rd*Rd;
  if (model == 2) return 1.0 - t.x - t.y + t.x*Rd*Rd + t.y*Rd*Rd*Rd*Rd;
  if (model == 3) { float Rd2 = Rd*Rd; return t.x*Rd2*Rd + t.y*Rd2 + t.z*Rd + (1.0 - t.x - t.y - t.z); }
  return 1.0;
}
void main(){
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uOutSize;      // screen px, y down
  vec2 cuv = (px - uView.xy) / uView.zw;               // crop uv, y down
  vec2 iuv;
  if (uCropMode == 1){
    // show whole rotated image; cuv is in "full image" space here
    vec2 center = vec2(0.5); vec2 d = cuv - center; d.x *= uAspect; d = rot(d, uAngle); d.x /= uAspect; iuv = center + d;
    iuv = (iuv - 0.5)*uFlip + 0.5;
  } else iuv = cropToImage(cuv);
  // lens profile distortion (auto, from lensfun match) — applied first, then the simple manual slider
  if (uLensProfileOn == 1 && uLensProfileDistModel != 0){
    vec2 d = iuv - 0.5; d.x *= uAspect; float Rd = length(d) * 2.0 / min(1.0, uAspect) * uLensScale;
    d *= lensfunDistortionRatio(uLensProfileDistModel, uLensProfileDistTerms, Rd);
    d.x /= uAspect; iuv = d + 0.5;
  }
  // lens distortion (simple radial, manual slider — layers on top of the profile correction above)
  if (uLensDist != 0.0){ vec2 d = iuv - 0.5; d.x *= uAspect; float r2 = dot(d,d); d *= 1.0 + uLensDist*0.25*r2; d.x /= uAspect; iuv = d + 0.5; }
  bool outside = iuv.x < 0.0 || iuv.x > 1.0 || iuv.y < 0.0 || iuv.y > 1.0;
  if (outside && uCropMode == 0){ outColor = vec4(0.0); return; }
  vec3 c;
  if (uBefore == 1){ c = texture(uSrc, iuv).rgb; }
  else {
    c = sampleAt(iuv);
    if (uSharpen > 0.0) c += sharpenLuma(iuv, c);
    // lens vignette correction (simple radial, manual slider — the lensfun profile's own
    // vignetting is undone earlier, in linear light, in the base pass)
    if (uLensVig != 0.0){ vec2 d = iuv - 0.5; d.x *= uAspect; c *= 1.0 + uLensVig*0.6*dot(d,d)*2.0; }
    // creative vignette (in crop space)
    if (uVignette != 0.0){
      vec2 d = (cuv - 0.5); float ar = uCrop.z*uAspect/uCrop.w; d.x *= mix(ar, 1.0, uVigRound*0.5 + 0.5);
      float r = length(d) / 0.7071;
      float mid = mix(0.2, 1.0, uVigMid); float f = max(uVigFeather, 0.02);
      float v = smoothstep(mid - f, mid + f, r);
      c = uVignette < 0.0 ? c * (1.0 + uVignette*v) : mix(c, vec3(1.0), uVignette*v*0.8);
    }
    if (uGrain > 0.0){
      vec2 g = floor(px / max(uGrainSize, 1.0));
      float n = hash(g) - 0.5; float L = lum(c);
      c += n * uGrain * 0.25 * (1.0 - abs(L*2.0-1.0)*0.7);
    }
    // glow (Orton / Glamour Glow): screen-blend a blurred, optionally highlight-gated copy
    if (uGlowAmount > 0.0){
      vec3 gcol = texture(uGlow, iuv).rgb;
      float gw = uGlowThreshold > 0.0 ? smoothstep(uGlowThreshold - 0.15, uGlowThreshold + 0.15, lum(gcol)) : 1.0;
      vec3 warm = mix(vec3(1.0), vec3(1.08, 1.0, 0.9), uGlowWarmth);
      vec3 screen = 1.0 - (1.0 - c) * (1.0 - clamp(gcol * warm, 0.0, 1.0));
      c = mix(c, screen, uGlowAmount * gw);
    }
    // sun flare: positionable additive halo + a small secondary flare dot
    if (uFlareAmt > 0.0){
      float ar = uCrop.z*uAspect/uCrop.w;
      vec3 warm = mix(vec3(1.0), vec3(1.15, 1.0, 0.75), uFlareWarmth);
      vec2 d = cuv - uFlareP; d.x *= ar;
      float r = length(d) / max(uFlareSize, 0.02);
      c += exp(-r*r*2.2) * uFlareAmt * warm;
      vec2 p2 = uFlareP + (vec2(0.5) - uFlareP) * 1.4;
      vec2 d2 = cuv - p2; d2.x *= ar;
      float r2 = length(d2) / max(uFlareSize*0.35, 0.01);
      c += exp(-r2*r2*3.0) * uFlareAmt * 0.35 * warm;
    }
  }
  c = clamp(c, 0.0, 1.0);
  if (uClip == 1){
    if (max(c.r, max(c.g, c.b)) >= 0.996) c = vec3(1.0, 0.15, 0.1);
    if (min(c.r, min(c.g, c.b)) <= 0.004) c = vec3(0.15, 0.35, 1.0);
  }
  if (uShowMask == 1){ float m = texture(uMaskViz, iuv).r; c = mix(c, vec3(1.0, 0.1, 0.1), m*0.55); }
  if (uCropMode == 1 && outside) c *= 0.0;
  outColor = vec4(c, 1.0);
}`;

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 required');
    this.gl = gl;
    this.halfFloat = !!gl.getExtension('EXT_color_buffer_float'); // 16F linear filtering is core in WebGL2
    // 16-bit export: 32-bit float intermediates need linear filtering of float textures,
    // and 16-bit sources upload directly as normalised 16-bit textures when available
    this.float32 = this.halfFloat && !!gl.getExtension('OES_texture_float_linear');
    this.norm16 = gl.getExtension('EXT_texture_norm16');
    this.precise = false;
    gl.getExtension('EXT_color_buffer_half_float');
    this.quad = gl.createVertexArray(); gl.bindVertexArray(this.quad);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.prog = {
      base: this._program(VS, FS_BASE), mask: this._program(VS, FS_MASK), local: this._program(VS, FS_LOCAL),
      blur: this._program(VS, FS_BLUR), final: this._program(VS, FS_FINAL), sky: this._program(VS, FS_SKY),
    };
    this.src = null; this.denoised = null; this.w = 0; this.h = 0;
    this.fbo = {}; this.maskTextures = new Map(); this.skyTextures = new Map();
    this.curveTex = this._tex(256, 1, null, gl.RGBA8);
  }
  _program(vs, fs) {
    const gl = this.gl;
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace('[0]', '')] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  _tex(w, h, data, internal, linear = true) {
    const gl = this.gl; const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    const fmt = internal === gl.R8 ? gl.RED : gl.RGBA; const type = internal === gl.RGBA16F ? gl.HALF_FLOAT : internal === gl.RGBA32F ? gl.FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, fmt, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  _fbo(name, w, h, internal) {
    const gl = this.gl; const old = this.fbo[name];
    if (old && old.w === w && old.h === h && old.internal === internal) return old;
    if (old) { gl.deleteTexture(old.tex); gl.deleteFramebuffer(old.fb); }
    const tex = this._tex(w, h, null, internal); const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return (this.fbo[name] = { tex, fb, w, h, internal });
  }
  _draw(fbo, w, h) { const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, fbo ? fbo.fb : null); gl.viewport(0, 0, w, h); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
  _bind(unit, tex, loc) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit); }

  /** Load an image (HTMLImageElement / ImageBitmap). hq=true uses 16-bit float intermediates. */
  setImage(img, hq = true) {
    const gl = this.gl;
    if (this.src) gl.deleteTexture(this.src);
    this.w = img.width; this.h = img.height; this.hq = hq && this.halfFloat; this.precise = false;
    this.src = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._buildBlurs();
    for (const t of this.maskTextures.values()) gl.deleteTexture(t.tex);
    this.maskTextures.clear();
    if (this.denoised) { gl.deleteTexture(this.denoised); this.denoised = null; }
  }
  /** Like setImage(), but for a pre-decoded 16-bit-precision RGBA buffer
   *  (Float32Array, values 0..1) instead of an HTMLImageElement/ImageBitmap.
   *  Uploads into a native RGBA16F texture — valid WebGL2 combination
   *  (RGBA16F accepts type=FLOAT as well as HALF_FLOAT), no extension
   *  needed for texture creation, no shader changes anywhere since every
   *  existing texture(sampler2D, ...) call already returns a normalized
   *  vec4 regardless of the source texture's bit depth. Deliberately does
   *  NOT go through the _tex() helper, which hardcodes HALF_FLOAT for
   *  RGBA16F and is otherwise only ever used with data=null (FBOs) — this
   *  mirrors setImage() itself, which also builds its texture inline. */
  setImage16(data, w, h, precise = false) {
    // data: Float32Array (0..1), or Uint16Array (0..65535) which uploads as a
    // normalised 16-bit texture when EXT_texture_norm16 exists (no 2x float copy).
    // precise: 32-bit float intermediates, for 16-bit export.
    const gl = this.gl;
    if (this.src) gl.deleteTexture(this.src);
    this.w = w; this.h = h; this.hq = this.halfFloat; this.precise = precise && this.float32;
    this.src = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (data instanceof Uint16Array && this.norm16) gl.texImage2D(gl.TEXTURE_2D, 0, this.norm16.RGBA16_EXT, w, h, 0, gl.RGBA, gl.UNSIGNED_SHORT, data);
    else {
      if (data instanceof Uint16Array) { const f = new Float32Array(data.length); for (let i = 0; i < data.length; i++) f[i] = data[i] / 65535; data = f; }
      gl.texImage2D(gl.TEXTURE_2D, 0, this.precise ? gl.RGBA32F : gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._buildBlurs();
    for (const t of this.maskTextures.values()) gl.deleteTexture(t.tex);
    this.maskTextures.clear();
    if (this.denoised) { gl.deleteTexture(this.denoised); this.denoised = null; }
  }
  _buildBlurs() {
    // two luminance blurs of the source at reduced resolution: small (texture) and large (clarity/dehaze)
    const gl = this.gl; const P = this.prog.blur; gl.useProgram(P.p);
    const mk = (name, div, passes) => {
      const w = Math.max(1, Math.round(this.w / div)), h = Math.max(1, Math.round(this.h / div));
      let a = this._fbo(name + 'A', w, h, gl.RGBA8), b = this._fbo(name + 'B', w, h, gl.RGBA8);
      let input = this.src;
      for (let i = 0; i < passes; i++) {
        this._bind(0, input, P.u.uTex); gl.uniform2f(P.u.uDir, 1 / w, 0); gl.uniform1i(P.u.uLum, 1); this._draw(a, w, h);
        this._bind(0, a.tex, P.u.uTex); gl.uniform2f(P.u.uDir, 0, 1 / h); this._draw(b, w, h); input = b.tex;
      }
      return b.tex;
    };
    this.blurS = mk('blurS', 2, 1); this.blurL = mk('blurL', 8, 3);
  }
  /** Wide color blur of the current (edited) composite, for the glow effect. Wider radius = bigger tap spacing, not more passes. */
  _buildGlow(srcTex, W, H, radiusPct) {
    const gl = this.gl; const P = this.prog.blur; gl.useProgram(P.p);
    const w = Math.max(1, Math.round(W / 6)), h = Math.max(1, Math.round(H / 6));
    const a = this._fbo('glowA', w, h, gl.RGBA8), b = this._fbo('glowB', w, h, gl.RGBA8);
    const step = 1 + (radiusPct / 100) * 6;
    this._bind(0, srcTex, P.u.uTex); gl.uniform2f(P.u.uDir, step / w, 0); gl.uniform1i(P.u.uLum, 0); this._draw(a, w, h);
    this._bind(0, a.tex, P.u.uTex); gl.uniform2f(P.u.uDir, 0, step / h); this._draw(b, w, h);
    return b.tex;
  }
  /** mask data: ImageData-like canvas or Image for brush/AI masks */
  setMaskTexture(id, source) {
    const gl = this.gl; const old = this.maskTextures.get(id);
    const tex = old ? old.tex : gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.maskTextures.set(id, { tex });
  }
  /** Library sky image, cached by asset id (persists across setImage() — the
   *  same sky asset is reusable across photos, unlike per-photo mask textures). */
  setSkyTexture(assetId, source) {
    const gl = this.gl; const tex = this.skyTextures.get(assetId) || gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.skyTextures.set(assetId, tex);
  }
  /** Denoised base texture (from the AI denoise endpoint), blended in FS_BASE via uDenoiseAmount. */
  setDenoised(source, noiseSigma = 0) {
    const gl = this.gl; this.noiseSigma = noiseSigma;
    if (!this.denoised) this.denoised = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.denoised);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  setCurve(lut) { // Uint8Array 256*4: r,g,b channel curves, a = master
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  }

  /** Render. opts: { edits, view:{x,y,scale}, outW, outH, cropMode, before, clip, showMaskId, toPixels } */
  render(o) {
    const gl = this.gl; if (!this.src) return null;
    const e = o.edits; const W = this.w, H = this.h; const fmt = this.precise ? gl.RGBA32F : this.hq ? gl.RGBA16F : gl.RGBA8;
    // ---- base pass
    let P = this.prog.base; gl.useProgram(P.p);
    const base = this._fbo('base', W, H, fmt);
    this._bind(0, this.src, P.u.uSrc); this._bind(1, this.blurS, P.u.uBlurS); this._bind(2, this.blurL, P.u.uBlurL); this._bind(3, this.curveTex, P.u.uCurve);
    this._bind(4, this.denoised || this.src, P.u.uDenoised);
    const t = e.tone, pr = e.presence, wb = e.wb;
    gl.uniform1f(P.u.uDenoiseAmount, this.denoised ? pr.denoise / 100 : 0);
    gl.uniform1f(P.u.uDenoiseDetail, (pr.denoiseDetail ?? 0) / 100); gl.uniform1f(P.u.uNoiseSigma, this.noiseSigma || 0.02);
    gl.uniform1f(P.u.uTemp, wb.temp / 100); gl.uniform1f(P.u.uTint, wb.tint / 100);
    const cm = o.cameraMatrix?.length === 9 ? o.cameraMatrix : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    gl.uniformMatrix3fv(P.u.uCameraMatrix, false, cm);
    gl.uniform1f(P.u.uExposure, t.exposure); gl.uniform1f(P.u.uContrast, t.contrast / 100);
    gl.uniform1f(P.u.uHighlights, t.highlights / 100); gl.uniform1f(P.u.uShadows, t.shadows / 100);
    gl.uniform1f(P.u.uWhites, t.whites / 100); gl.uniform1f(P.u.uBlacks, t.blacks / 100);
    gl.uniform1f(P.u.uTexture, pr.texture / 100); gl.uniform1f(P.u.uClarity, pr.clarity / 100); gl.uniform1f(P.u.uDehaze, pr.dehaze / 100);
    gl.uniform1f(P.u.uVibrance, pr.vibrance / 100); gl.uniform1f(P.u.uSaturation, pr.saturation / 100);
    gl.uniform1f(P.u.uColorEnhance, (e.effects.colorEnhance || 0) / 100); gl.uniform1f(P.u.uDynamicContrast, (e.effects.dynamicContrast || 0) / 100);
    gl.uniform1fv(P.u.uHslHue, new Float32Array(e.hsl.hue.map(v => v / 100)));
    gl.uniform1fv(P.u.uHslSat, new Float32Array(e.hsl.sat.map(v => v / 100)));
    gl.uniform1fv(P.u.uHslLum, new Float32Array(e.hsl.lum.map(v => v / 100)));
    const g = e.grading;
    gl.uniform3f(P.u.uGradeSh, g.shadows.h / 360, g.shadows.s / 100, g.shadows.l / 100);
    gl.uniform3f(P.u.uGradeMid, g.midtones.h / 360, g.midtones.s / 100, g.midtones.l / 100);
    gl.uniform3f(P.u.uGradeHi, g.highlights.h / 360, g.highlights.s / 100, g.highlights.l / 100);
    gl.uniform1f(P.u.uGradeBlend, g.blending / 100); gl.uniform1f(P.u.uGradeBalance, g.balance / 100);
    gl.uniform1i(P.u.uHasCurve, o.hasCurve ? 1 : 0);
    const lp = o.lensProfile, vt = lp?.vignetting?.terms;
    const vigOn = !!(lp?.matched && vt && vt.some(x => x !== 0));
    gl.uniform1i(P.u.uLensVigOn, vigOn ? 1 : 0);
    gl.uniform3f(P.u.uLensVigTerms, vt?.[0] || 0, vt?.[1] || 0, vt?.[2] || 0);
    gl.uniform1f(P.u.uLensVigAmount, (e.lens.profileVignette ?? 100) / 100);
    gl.uniform1f(P.u.uLensScale, lp?.radiusScale || 1); gl.uniform1f(P.u.uAspect, W / H);
    this._draw(base, W, H);

    // ---- masks
    let cur = base; let maskVizTex = null;
    const ping = this._fbo('pingA', W, H, fmt), pong = this._fbo('pingB', W, H, fmt);
    let nextOut = ping;
    const masks = (e.masks || []).filter(m => m.enabled !== false);
    for (const m of masks) {
      const mt = this._renderMask(m, base.tex, W, H);
      if (o.showMaskId === m.id) maskVizTex = mt;
      if (m.type === 'ai' && m.params?.kind === 'sky' && m.sky?.assetId) {
        const skyTex = this.skyTextures.get(m.sky.assetId);
        if (skyTex) {
          P = this.prog.sky; gl.useProgram(P.p);
          this._bind(0, cur.tex, P.u.uIn); this._bind(1, mt, P.u.uMask); this._bind(2, skyTex, P.u.uSky);
          gl.uniform1f(P.u.uSkyScale, (m.sky.scale ?? 100) / 100);
          gl.uniform1f(P.u.uSkyOffX, (m.sky.offsetX ?? 0) / 200); gl.uniform1f(P.u.uSkyOffY, (m.sky.offsetY ?? 0) / 200);
          gl.uniform1f(P.u.uSkyFlip, m.sky.flipH ? 1 : 0);
          this._draw(nextOut, W, H); cur = nextOut; nextOut = nextOut === ping ? pong : ping;
        }
      }
      const a = m.adj; if (!Object.values(a).some(v => v !== 0)) continue;
      P = this.prog.local; gl.useProgram(P.p);
      this._bind(0, cur.tex, P.u.uIn); this._bind(1, mt, P.u.uMask); this._bind(2, this.blurL, P.u.uBlurL); this._bind(3, this.src, P.u.uSrc); this._bind(4, this.blurS, P.u.uBlurS);
      gl.uniform1f(P.u.uTexture, (a.texture || 0) / 100); gl.uniform1f(P.u.uSharpness, (a.sharpness || 0) / 100); gl.uniform2f(P.u.uTexel, 1 / W, 1 / H);
      gl.uniform1f(P.u.uTemp, a.temp / 100); gl.uniform1f(P.u.uTint, a.tint / 100); gl.uniform1f(P.u.uExposure, a.exposure);
      gl.uniform1f(P.u.uContrast, a.contrast / 100); gl.uniform1f(P.u.uHighlights, a.highlights / 100); gl.uniform1f(P.u.uShadows, a.shadows / 100);
      gl.uniform1f(P.u.uWhites, a.whites / 100); gl.uniform1f(P.u.uBlacks, a.blacks / 100); gl.uniform1f(P.u.uSaturation, a.saturation / 100);
      gl.uniform1f(P.u.uClarity, a.clarity / 100); gl.uniform1f(P.u.uDehaze, a.dehaze / 100); gl.uniform1f(P.u.uAmount, (m.amount ?? 100) / 100);
      this._draw(nextOut, W, H); cur = nextOut; nextOut = nextOut === ping ? pong : ping;
    }
    // a raw preview-only texture (e.g. the object-removal brush while painting, before the
    // backend has actually inpainted anything) can be shown as an overlay without being a real mask
    if (o.showMaskId && !maskVizTex) { const t = this.maskTextures.get(o.showMaskId); if (t) maskVizTex = t.tex; }

    // ---- glow (Orton / Glamour Glow): blur of the edited composite, built only when active
    const glow = e.effects.glow;
    const glowTex = glow && glow.amount > 0 ? this._buildGlow(cur.tex, W, H, glow.radius ?? 50) : null;

    // ---- final
    P = this.prog.final; gl.useProgram(P.p);
    const outW = o.outW, outH = o.outH; let outFbo = null;
    if (o.toFloat) outFbo = this._fbo('outF', outW, outH, gl.RGBA32F);
    else if (o.toPixels) outFbo = this._fbo('out', outW, outH, gl.RGBA8);
    this._bind(0, cur.tex, P.u.uIn); this._bind(1, this.src, P.u.uSrc); this._bind(2, maskVizTex || this.src, P.u.uMaskViz);
    this._bind(3, glowTex || cur.tex, P.u.uGlow);
    gl.uniform2f(P.u.uTexel, 1 / W, 1 / H); gl.uniform2f(P.u.uOutSize, outW, outH);
    const c = e.crop; gl.uniform4f(P.u.uCrop, c.x, c.y, c.w, c.h);
    gl.uniform1f(P.u.uAngle, c.angle * Math.PI / 180); gl.uniform1f(P.u.uAspect, W / H);
    gl.uniform2f(P.u.uFlip, c.flipH ? -1 : 1, c.flipV ? -1 : 1);
    gl.uniform4f(P.u.uView, o.view.x, o.view.y, o.view.sx, o.view.sy);
    gl.uniform1i(P.u.uCropMode, o.cropMode ? 1 : 0); gl.uniform1i(P.u.uBefore, o.before ? 1 : 0);
    gl.uniform1i(P.u.uClip, o.clip ? 1 : 0); gl.uniform1i(P.u.uShowMask, maskVizTex ? 1 : 0);
    const d = e.detail, fx = e.effects, ln = e.lens;
    const scaleFix = o.toPixels ? 1 : 1; // sharpen radius is in source texels
    gl.uniform1f(P.u.uSharpen, d.sharpen / 100); gl.uniform1f(P.u.uSharpRadius, d.radius * scaleFix); gl.uniform1f(P.u.uSharpMask, d.masking / 100); gl.uniform1f(P.u.uSharpDetail, (d.detail ?? 25) / 100);
    gl.uniform1f(P.u.uVignette, fx.vignette / 100); gl.uniform1f(P.u.uVigMid, fx.midpoint / 100); gl.uniform1f(P.u.uVigFeather, fx.feather / 100);
    gl.uniform1f(P.u.uVigRound, fx.roundness / 100); gl.uniform1f(P.u.uGrain, fx.grain / 100); gl.uniform1f(P.u.uGrainSize, fx.grainSize * (o.toPixels ? outW / 1500 : 1));
    gl.uniform1f(P.u.uLensVig, ln.vignette / 100); gl.uniform1f(P.u.uLensDist, ln.distortion / 100);
    const distModelNum = { poly3: 1, poly5: 2, ptlens: 3 }[lp?.distortion?.model] || 0;
    gl.uniform1i(P.u.uLensProfileOn, lp?.matched ? 1 : 0);
    gl.uniform1i(P.u.uLensProfileDistModel, distModelNum);
    const dt = lp?.distortion?.terms || [0, 0, 0]; gl.uniform3f(P.u.uLensProfileDistTerms, dt[0], dt[1], dt[2]);
    gl.uniform1f(P.u.uLensScale, lp?.radiusScale || 1);
    gl.uniform1f(P.u.uGlowAmount, glowTex ? (glow.amount ?? 0) / 100 : 0);
    gl.uniform1f(P.u.uGlowThreshold, (glow?.threshold ?? 0) / 100); gl.uniform1f(P.u.uGlowWarmth, (glow?.warmth ?? 0) / 100);
    const sf = fx.sunFlare || {};
    gl.uniform2f(P.u.uFlareP, (sf.x ?? 50) / 100, (sf.y ?? 30) / 100); gl.uniform1f(P.u.uFlareAmt, (sf.amount ?? 0) / 100);
    gl.uniform1f(P.u.uFlareSize, (sf.size ?? 40) / 100); gl.uniform1f(P.u.uFlareWarmth, (sf.warmth ?? 40) / 100);
    this._draw(outFbo, outW, outH);
    if (o.toFloat) return null; // read back in strips with readFloatRows()
    if (o.toPixels) {
      const px = new Uint8Array(outW * outH * 4); gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); return px;
    }
    return null;
  }
  /** After render({toFloat:true}): rows [y, y+n) of the float output (GL row order,
   *  bottom-up) as RGBA Float32Array, so a large export never needs one huge buffer. */
  readFloatRows(y, n, w, out) {
    const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.outF.fb);
    gl.readPixels(0, y, w, n, gl.RGBA, gl.FLOAT, out); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return out;
  }
  /** Free the big float output target once an export is done. */
  releaseFloat() { const f = this.fbo.outF; if (f) { this.gl.deleteTexture(f.tex); this.gl.deleteFramebuffer(f.fb); delete this.fbo.outF; } }
  _renderMask(m, baseTex, W, H) {
    const gl = this.gl; const P = this.prog.mask; gl.useProgram(P.p);
    const f = this._fbo('mask_' + m.id, W, H, gl.R8);
    this._bind(0, baseTex, P.u.uBase);
    const mt = this.maskTextures.get(m.id); this._bind(1, mt ? mt.tex : this.src, P.u.uTex);
    const p = m.params || {};
    const type = m.type === 'linear' ? 0 : m.type === 'radial' ? 1 : (m.type === 'range' ? 3 : 2);
    gl.uniform1i(P.u.uType, type);
    if (type === 0) gl.uniform4f(P.u.uP, p.x0, p.y0, p.x1, p.y1);
    else if (type === 1) { gl.uniform4f(P.u.uP, p.cx, p.cy, p.rx, p.ry); gl.uniform2f(P.u.uQ, (p.angle || 0) * Math.PI / 180, (p.feather ?? 50) / 100); }
    gl.uniform1f(P.u.uAspect, W / H); gl.uniform1i(P.u.uInvert, m.invert ? 1 : 0);
    const r = m.range || {}; gl.uniform1i(P.u.uRangeOn, r.enabled ? 1 : 0); gl.uniform4f(P.u.uRange, (r.lo ?? 0) / 100, (r.hi ?? 100) / 100, (r.smooth ?? 20) / 100, 0);
    const cr = m.colorRange || {}; gl.uniform1i(P.u.uColorRangeOn, cr.enabled ? 1 : 0); gl.uniform4f(P.u.uColorRange, (cr.h ?? 0) / 360, (cr.s ?? 50) / 100, (cr.v ?? 50) / 100, (cr.tol ?? 30) / 100);
    const ed = m.edge || {}; gl.uniform1f(P.u.uEdgeShift, (ed.shift || 0) / 100); gl.uniform1f(P.u.uEdgeSoft, (ed.soft || 0) / 100);
    const rt = this.maskTextures.get(m.id + '_refine');
    this._bind(2, rt ? rt.tex : this.src, P.u.uRefine); gl.uniform1i(P.u.uRefineOn, rt ? 1 : 0);
    this._draw(f, W, H); return f.tex;
  }
  /** Downsampled histogram of the currently displayed pixels */
  histogram(outW, outH) {
    const gl = this.gl; const w = Math.min(256, outW), h = Math.min(160, outH);
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // read a sparse sample grid across the canvas for speed
    const bins = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
    const sx = Math.max(1, Math.floor(outW / w)), sy = Math.max(1, Math.floor(outH / h));
    const row = new Uint8Array(outW * 4); let n = 0;
    for (let y = 0; y < outH; y += sy) {
      gl.readPixels(0, y, outW, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
      for (let x = 0; x < outW; x += sx) { const i = x * 4; if (row[i + 3] === 0) continue; bins.r[row[i]]++; bins.g[row[i + 1]]++; bins.b[row[i + 2]]++; bins.l[(row[i] * 54 + row[i + 1] * 183 + row[i + 2] * 19) >> 8]++; n++; }
    }
    return { ...bins, n };
  }
}

/** Monotone cubic interpolation of curve points -> Uint8Array(256) */
export function curveLut(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length; const out = new Uint8Array(256);
  if (n < 2) { for (let i = 0; i < 256; i++) out[i] = i; return out; }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const d = [], m = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - xs[i], 1e-6));
  m.push(d[0]); for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2); m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) { if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; } const a = m[i] / d[i], b = m[i + 1] / d[i]; const s = a * a + b * b; if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; } }
  for (let i = 0; i < 256; i++) {
    const x = i / 255; let k = 0; while (k < n - 2 && x > xs[k + 1]) k++;
    const h = xs[k + 1] - xs[k]; const t = h > 0 ? (x - xs[k]) / h : 0;
    const t2 = t * t, t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
    out[i] = Math.round(Math.max(0, Math.min(1, x < xs[0] ? ys[0] : x > xs[n - 1] ? ys[n - 1] : y)) * 255);
  }
  return out;
}
