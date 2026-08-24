# Keep this image on the exact same preview release as @cloudflare/sandbox in package.json.
# The digest prevents a mutable registry tag from changing a reviewed release build.
FROM docker.io/cloudflare/sandbox:0.13.0-next.738.2@sha256:f4b2137219568aa44539ab93c0e774db6bcab323c134c5088447916e58f15e75

# The npm executable belongs to the pinned Cloudflare runtime image. OPAP does
# not run npm inside the sandbox, so suppress its unrelated upgrade notice.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
