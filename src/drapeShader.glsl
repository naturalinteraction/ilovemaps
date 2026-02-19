uniform sampler2D colorTexture;
uniform sampler2D czm_depthTexture;
uniform sampler2D videoTexture;
uniform vec3 droneEcefPosition;
uniform mat4 droneCameraMatrix;
uniform float videoAlpha;

in vec2 v_textureCoordinates;

void main() {
    float depth = czm_readDepth(czm_depthTexture, v_textureCoordinates);

    // Sky / background: depth at far plane — pass through unchanged
    if (depth >= 1.0) {
        out_FragColor = texture(colorTexture, v_textureCoordinates);
        return;
    }

    // Reconstruct ECEF world position from depth + screen UV
    vec4 ndc = vec4(v_textureCoordinates * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 eyeCoords = czm_inverseProjection * ndc;
    eyeCoords /= eyeCoords.w;
    vec4 worldPos = czm_inverseView * eyeCoords;

    // Relative-to-center: shift origin to drone ECEF position
    // (keeps float32 precision — ECEF values are ~6.4 M metres)
    vec3 rtcPos = worldPos.xyz - droneEcefPosition;

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

    vec4 video = texture(videoTexture, droneUV);
    vec4 scene = texture(colorTexture, v_textureCoordinates);
    out_FragColor = mix(scene, video, videoAlpha);
}
