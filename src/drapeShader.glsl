uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D videoTexture;
uniform mat4 droneCameraMatrix;
uniform float videoAlpha;
uniform vec3 cameraOffsetFromDrone; // = cameraECEF - droneECEF, computed in 64-bit JS

in vec2 v_textureCoordinates;

void main() {
    float depth = czm_readDepth(depthTexture, v_textureCoordinates);

    // Sky / background: pass through unchanged
    if (depth >= 1.0) {
        out_FragColor = texture(colorTexture, v_textureCoordinates);
        return;
    }

    // Reconstruct eye-space position from the depth buffer.
    // This uses whatever geometry Cesium actually rendered (including DSM terrain),
    // so the drone texture naturally follows the 3D surface.
    vec4 clipPos = vec4(v_textureCoordinates * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 eyePos = czm_inverseProjection * clipPos;
    eyePos /= eyePos.w;

    // Convert eye-space to RTC (relative to drone ECEF position).
    // mat3(czm_inverseView) rotates from eye space to ECEF (no translation).
    // eyePos.xyz is camera-relative, so the result is world-direction * distance.
    // Adding cameraOffsetFromDrone (= cameraECEF - droneECEF, computed in 64-bit JS)
    // gives the position relative to the drone — all small values, no float32 precision loss.
    vec3 rtcPos = mat3(czm_inverseView) * eyePos.xyz + cameraOffsetFromDrone;

    // Project through drone camera (proj * view in RTC frame)
    vec4 droneClip = droneCameraMatrix * vec4(rtcPos, 1.0);

    // Reject pixels behind the drone camera
    if (droneClip.w <= 0.0) {
        out_FragColor = texture(colorTexture, v_textureCoordinates);
        return;
    }

    // Perspective divide -> normalised UV [0, 1]
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

    // Fade out when the viewer camera is far from the projection.
    float camDist = length(cameraOffsetFromDrone);
    float camFade = 1.0 - smoothstep(1500.0, 2500.0, camDist);

    vec4 video = textureGrad(videoTexture, droneUV, dFdx(droneUV), dFdy(droneUV));
    vec4 scene = texture(colorTexture, v_textureCoordinates);
    out_FragColor = mix(scene, video, videoAlpha * stretchFade * camFade);
}
