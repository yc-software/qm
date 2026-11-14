# Use a typed controller for local Docker

If a containerized Core manages local Docker sandboxes, I'd like it to use a constrained typed controller that validates images, mounts, networks, permissions, and ownership labels, rather than giving Core direct access to the Docker socket.
