# Palimpsest Studio — stdlib Python, no dependencies.
FROM python:3.12-slim
WORKDIR /app
COPY build.py server.py ./
COPY studio/ studio/
# only the Writing Record's assets are needed from the Palimpsest submodule
COPY vendor/palimpsest/palimpsest/engine/assets/ vendor/palimpsest/palimpsest/engine/assets/
RUN python3 build.py && rm -rf vendor
RUN useradd --system --user-group --uid 10001 studio && mkdir -p /data
ENV HOST=0.0.0.0 PORT=8080 STUDIO_DATA=/data PYTHONUNBUFFERED=1
EXPOSE 8080
# Fly mounts the volume root-owned over /data: take it, then drop to the studio user.
CMD ["sh", "-c", "chown -R studio:studio /data && exec setpriv --reuid=studio --regid=studio --init-groups python3 server.py"]
