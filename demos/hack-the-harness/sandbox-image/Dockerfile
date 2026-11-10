FROM ghcr.io/patniko/managed-copilot-sandbox:0.1.0

# The spreadsheets skill needs openpyxl. Sandboxes have no network access, so it goes in the image, installed from
# wheels in this folder so the build needs no package index either.
COPY wheels /tmp/wheels
RUN /home/agent/.venv/bin/pip install --no-cache-dir --no-index /tmp/wheels/*.whl
