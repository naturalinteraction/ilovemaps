uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D videoTexture;
uniform vec3 droneEcefPosition;
uniform mat4 droneCameraMatrix;
uniform float videoAlpha;
uniform float droneHeightAboveGround;
uniform vec3 cameraOffsetFromDrone; // = cameraECEF - droneECEF, computed in 64-bit JS

in vec2 v_textureCoordinates;

void main() {
    float depth = czm_readDepth(depthTexture, v_textureCoordinates);

    // Sky / background: pass through unchanged
    if (depth >= 1.0) {
        out_FragColor = texture(colorTexture, v_textureCoordinates);
        return;
    }

    // Ray direction in world space from screen UV.
    // Use mat3(czm_inverseView) with w=0 to get direction without large-ECEF subtraction.
    vec4 clipFar = vec4(v_textureCoordinates * 2.0 - 1.0, 1.0, 1.0);
    vec4 eyeFar = czm_inverseProjection * clipFar;
    eyeFar /= eyeFar.w;
    vec3 rayDir = normalize(mat3(czm_inverseView) * eyeFar.xyz);

    // Ground plane in RTC frame (origin = drone ECEF position).
    // In RTC the plane equation is: dot(planeNormal, rtcPoint) = -heightAboveGround
    vec3 planeNormal = normalize(droneEcefPosition);

    float denom = dot(planeNormal, rayDir);
    if (abs(denom) < 1e-6) {
        out_FragColor = texture(colorTexture, v_textureCoordinates);
        return;
    }

    // cameraOffsetFromDrone is (cameraECEF - droneECEF) computed in JS doubles,
    // so all values here are small (metres, not millions of metres) → full float precision.
    float t = (-droneHeightAboveGround - dot(planeNormal, cameraOffsetFromDrone)) / denom;
    if (t < 0.0) {
        out_FragColor = texture(colorTexture, v_textureCoordinates);
        return;
    }

    // RTC intersection point — all small numbers, full 32-bit precision
    vec3 rtcPos = cameraOffsetFromDrone + rayDir * t;

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
