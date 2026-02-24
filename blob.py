import numpy as np
import matplotlib.pyplot as plt

# --- PARAMETERS YOU WILL TUNE ---
num_clusters = 4
units_per_cluster = 10
sigma = 15.0        # Controls thickness / bridge width
threshold = 0.2    # Lower = thinner bridges, higher = fatter blob
grid_res = 300      # Resolution of the field

#np.random.seed(42)

# --- Generate clustered units ---
cluster_centers = np.random.uniform(-50, 50, size=(num_clusters, 2))
units = []

for center in cluster_centers:
    cluster = center + np.random.normal(scale=5.0, size=(units_per_cluster, 2))
    units.append(cluster)

units = np.vstack(units)

# --- Grid for scalar field ---
margin = 20
xmin, ymin = units.min(axis=0) - margin
xmax, ymax = units.max(axis=0) + margin

x = np.linspace(xmin, xmax, grid_res)
y = np.linspace(ymin, ymax, grid_res)
X, Y = np.meshgrid(x, y)

# --- Gaussian influence field (metaball-style) ---
field = np.zeros_like(X)

for ux, uy in units:
    dx = X - ux
    dy = Y - uy
    field += np.exp(-(dx**2 + dy**2) / (2 * sigma**2))

# Normalize for stable thresholding
field /= field.max()

# --- Extract single smooth blob via isocontour ---
plt.figure(figsize=(8, 8))
plt.contour(X, Y, field, levels=[threshold])  # The blob
plt.scatter(units[:, 0], units[:, 1], s=10)   # Units
plt.gca().set_aspect('equal', adjustable='box')
plt.title("Single Smooth Blob (Gaussian Field + Isocontour)")
plt.xlabel("X")
plt.ylabel("Y")
plt.show()