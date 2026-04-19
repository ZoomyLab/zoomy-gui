import matplotlib
matplotlib.use("agg")                      # headless worker — mpl mustn't pick a GUI backend
import matplotlib.pyplot as plt

fig, ax = plt.subplots(1, 1, figsize=(6, 4))
ax.set_title("Empty View")
ax.set_xlabel("x")
ax.set_ylabel("y")
display(fig)
