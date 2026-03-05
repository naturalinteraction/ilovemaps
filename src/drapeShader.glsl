uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D videoTexture;
uniform vec3 droneEcefPosition;
uniform mat4 droneCameraMatrix;
uniform float videoAlpha;

in vec2 v_textureCoordinates;

// 4-tap bilinear depth sampling to smooth terrain mesh faceting artifacts.
// The depth texture uses NEAREST filtering, so adjacent texels can jump at
// triangle edges.  Manual bilinear interpolation blends across those edges.
float readDepthBilinear(sampler2D dt, vec2 uv) {
    vec2 sz  = vec2(textureSize(dt, 0));
    vec2 tc  = uv * sz - 0.5;
    vec2 f   = fract(tc);
    vec2 base = (floor(tc) + 0.5) / sz;
    vec2 dx  = vec2(1.0 / sz.x, 0.0);
    vec2 dy  = vec2(0.0, 1.0 / sz.y);

    float d00 = czm_readDepth(dt, base);
    float d10 = czm_readDepth(dt, base + dx);
    float d01 = czm_readDepth(dt, base + dy);
    float d11 = czm_readDepth(dt, base + dx + dy);

    // Reject sky samples (depth == 1) from the blend
    float w00 = d00 < 1.0 ? 1.0 : 0.0;
    float w10 = d10 < 1.0 ? 1.0 : 0.0;
    float w01 = d01 < 1.0 ? 1.0 : 0.0;
    float w11 = d11 < 1.0 ? 1.0 : 0.0;

    float top    = mix(d00 * w00, d10 * w10, f.x);
    float bottom = mix(d01 * w01, d11 * w11, f.x);
    float wTop    = mix(w00, w10, f.x);
    float wBottom = mix(w01, w11, f.x);
    float wAll    = mix(wTop, wBottom, f.y);

    if (wAll < 0.01) return 1.0; // all sky
    return mix(top, bottom, f.y) / wAll;
}

vec4 reconstructWorldPos(float depth) {
    vec4 ndc = vec4(v_textureCoordinates * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 eyeCoords = czm_inverseProjection * ndc;
    eyeCoords /= eyeCoords.w;
    return czm_inverseView * eyeCoords;
}

void main() {
    float depth = readDepthBilinear(depthTexture, v_textureCoordinates);

    // Sky / background: depth at far plane — pass through unchanged
    if (depth >= 1.0) {
        out_FragColor = texture(colorTexture, v_textureCoordinates);
        return;
    }

    // Reconstruct ECEF world position from smoothed depth + screen UV
    vec4 worldPos = reconstructWorldPos(depth);

    // Also reconstruct with raw (unsmoothed) depth for eye-space distance
    float rawDepth = czm_readDepth(depthTexture, v_textureCoordinates);
    vec4 rawNdc = vec4(v_textureCoordinates * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0);
    vec4 rawEye = czm_inverseProjection * rawNdc;
    rawEye /= rawEye.w;

    // Relative-to-center: shift origin to drone ECEF position
    vec3 rtcPos = worldPos.xyz - droneEcefPosition;

    // Don't project onto the drone indicator geometry (sphere + arrow) was 350
    if (length(rtcPos) < 0.0) {
        out_FragColor = texture(colorTexture, v_textureCoordinates);
        return;
    }

    // Project through drone camera (proj * view in RTC frame)
    vec4 droneClip = droneCameraMatrix * vec4(rtcPos, 1.0);

    // Reject pixels behind the drone camera
    if (droneClip.w <= 0.0) {
        out_FragColor = texture(colorTexture, v_textureCoordinates);
        return;
    }

    // Perspective divide → normalised UV [0, 1]
    vec2 droneUV = (droneClip.xy / droneClip.w) * 0.5 + 0.5;

    // Clip anything outside the drone's image frustum
    if (droneUV.x < 0.0 || droneUV.x > 1.0 ||
        droneUV.y < 0.0 || droneUV.y > 1.0) {
        out_FragColor = texture(colorTexture, v_textureCoordinates);
        return;
    }

    // Fade out distant terrain where the video texture is overly stretched.
    float dist = length(rtcPos);
    float stretchFade = 1.0 - smoothstep(800.0, 1200.0, dist);

    // Fade out when the viewer camera is far from the projection,
    // avoiding multi-frustum fragmentation artifacts.
    float camDist = length(rawEye.xyz);
    float camFade = 1.0 - smoothstep(1500.0, 2500.0, camDist);

    // Use screen-space derivatives for mipmap selection — blurs the video
    // texture at terrain triangle seams where droneUV changes abruptly.
    vec4 video = textureGrad(videoTexture, droneUV, dFdx(droneUV), dFdy(droneUV));
    vec4 scene = texture(colorTexture, v_textureCoordinates);
    out_FragColor = mix(scene, video, videoAlpha * stretchFade * camFade);
}
