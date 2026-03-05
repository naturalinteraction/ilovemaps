#!/usr/bin/env bash
# Extract telemetry and camera info from DJI MOV files.
# Usage: ./extract_drone_meta.sh <input.MOV>
# Outputs: JSON, C# code, and a PNG frame extraction.
# Requires: exiftool, ffmpeg, python3

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <input.MOV>" >&2
    exit 1
fi

INPUT="$1"
BASENAME="$(basename "$INPUT" .MOV)"
BASENAME="$(basename "$BASENAME" .mov)"
OUTDIR="$(dirname "$INPUT")"
FRAME_PNG="${OUTDIR}/${BASENAME}_frame.png"
JSON_OUT="${OUTDIR}/${BASENAME}_meta.json"
CS_OUT="${OUTDIR}/${BASENAME}_meta.cs"

if [ ! -f "$INPUT" ]; then
    echo "Error: file '$INPUT' not found" >&2
    exit 1
fi

# Check dependencies
for cmd in exiftool ffmpeg python3; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: '$cmd' not found" >&2
        exit 1
    fi
done

# Extract a frame at the midpoint of the video
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT")
MIDPOINT=$(python3 -c "print(f'{float(${DURATION})/2:.3f}')")
echo "Extracting frame at t=${MIDPOINT}s -> ${FRAME_PNG}"
ffmpeg -y -ss "$MIDPOINT" -i "$INPUT" -frames:v 1 -q:v 1 "${FRAME_PNG}" 2>/dev/null
echo "Frame saved: ${FRAME_PNG}"

# Extract metadata and compute everything in Python
exiftool -json "$INPUT" | python3 -c "
import json, sys, math, re

data = json.load(sys.stdin)[0]

# --- Parse GPS coordinates ---
def parse_dms(s):
    \"\"\"Parse DMS string like '43 deg 47\\' 51.85\\\" N' to decimal degrees.\"\"\"
    m = re.match(r\"([\\d.]+)\\s*deg\\s*([\\d.]+)'\\s*([\\d.]+)\\\"?\\s*([NSEW])\", s.strip())
    if not m:
        return None
    deg = float(m.group(1)) + float(m.group(2))/60 + float(m.group(3))/3600
    if m.group(4) in ('S', 'W'):
        deg = -deg
    return deg

lat = parse_dms(data.get('GPSLatitude', ''))
lon = parse_dms(data.get('GPSLongitude', ''))

# Altitude
alt_str = data.get('GPSAltitude', '0 m')
alt = float(re.match(r'([\\d.]+)', alt_str).group(1))

# --- Camera angles (gimbal) ---
cam_yaw   = float(data.get('CameraYaw', 0))
cam_pitch = float(data.get('CameraPitch', 0))
cam_roll  = float(data.get('CameraRoll', 0))

# --- Drone body angles ---
drone_yaw   = float(data.get('Yaw', 0))
drone_pitch = float(data.get('Pitch', 0))
drone_roll  = float(data.get('Roll', 0))

# --- Resolution and aspect ratio ---
w = int(data.get('ImageWidth', 3840))
h = int(data.get('ImageHeight', 2160))
aspect = w / h
aspect_str = f'{w}:{h}'
# Simplify
from math import gcd
g = gcd(w, h)
aspect_str = f'{w//g}:{h//g}'

# --- FOV calculation ---
# Known DJI camera specs by model (diagonal FOV in degrees)
KNOWN_FOVS = {
    'FC220':    78.8,   # Mavic Pro (26mm equiv, f/2.2)
    'FC220-Se': 78.8,   # Mavic Pro (same sensor/lens)
    'FC7203':   77.8,   # Mavic Air 2
    'FC3170':   83.0,   # Mavic 2 Pro
    'FC330':    94.0,   # Phantom 4
    'FC300S':   94.0,   # Phantom 3 Standard
    'FC350':    94.0,   # Inspire 1
}

model = data.get('Model', 'unknown')
diag_fov = KNOWN_FOVS.get(model)

if diag_fov is None:
    print(f'WARNING: Unknown model \"{model}\", cannot determine FOV. Using 81.9 as default.', file=sys.stderr)
    diag_fov = 81.9

# Compute HFOV and VFOV from diagonal FOV and aspect ratio
# diagonal_pixels = sqrt(w^2 + h^2)
diag_px = math.sqrt(w**2 + h**2)
diag_rad = math.radians(diag_fov)
# focal length in pixels: f = (diag_px/2) / tan(diag_fov/2)
f_px = (diag_px / 2) / math.tan(diag_rad / 2)
hfov = math.degrees(2 * math.atan(w / (2 * f_px)))
vfov = math.degrees(2 * math.atan(h / (2 * f_px)))

# --- Telemetry stability check ---
# With DJI MOVs that lack per-frame SRT data, we only have header values.
# The -err suffix fields should match the main fields for stable footage.
stability_warnings = []
for field in ['CameraPitch', 'CameraYaw', 'CameraRoll', 'GPSCoordinates']:
    main = data.get(field)
    err = data.get(f'{field}-err')
    if main is not None and err is not None and str(main) != str(err):
        stability_warnings.append(f'{field}: main={main}, err={err}')

# --- Build result ---
result = {
    'source_file': data.get('SourceFile', ''),
    'model': model,
    'latitude': round(lat, 8),
    'longitude': round(lon, 8),
    'altitude_m': round(alt, 2),
    'camera_yaw_deg': round(cam_yaw, 2),
    'camera_pitch_deg': round(cam_pitch, 2),
    'camera_roll_deg': round(cam_roll, 2),
    'drone_yaw_deg': round(drone_yaw, 2),
    'drone_pitch_deg': round(drone_pitch, 2),
    'drone_roll_deg': round(drone_roll, 2),
    'image_width': w,
    'image_height': h,
    'aspect_ratio': aspect_str,
    'diagonal_fov_deg': round(diag_fov, 2),
    'horizontal_fov_deg': round(hfov, 2),
    'vertical_fov_deg': round(vfov, 2),
    'frame_file': '${FRAME_PNG}',
}

if stability_warnings:
    result['stability_warnings'] = stability_warnings

# --- Output JSON ---
json_str = json.dumps(result, indent=2)
print(json_str)
with open('${JSON_OUT}', 'w') as f:
    f.write(json_str + '\n')
print(f'\nJSON saved to: ${JSON_OUT}', file=sys.stderr)

# --- Output C# code ---
cs = '''// Auto-generated from {source_file}
// Model: {model}
// Frame: {frame_file}

// Position
double latitude  = {latitude};
double longitude = {longitude};
double altitude  = {altitude_m};  // meters ASL

// Camera gimbal angles (degrees)
double cameraYaw   = {camera_yaw_deg};
double cameraPitch = {camera_pitch_deg};
double cameraRoll  = {camera_roll_deg};

// Drone body angles (degrees)
double droneYaw   = {drone_yaw_deg};
double dronePitch = {drone_pitch_deg};
double droneRoll  = {drone_roll_deg};

// Image dimensions
int imageWidth  = {image_width};
int imageHeight = {image_height};
// Aspect ratio: {aspect_ratio}

// Field of view (degrees)
double diagonalFov   = {diagonal_fov_deg};
double horizontalFov = {horizontal_fov_deg};
double verticalFov   = {vertical_fov_deg};
'''.format(**result)

with open('${CS_OUT}', 'w') as f:
    f.write(cs)
print(f'C# saved to: ${CS_OUT}', file=sys.stderr)
print(file=sys.stderr)
print('--- C# Code ---', file=sys.stderr)
print(cs, file=sys.stderr)
"

echo "Done."
