FROM python:3.11-slim

WORKDIR /app

RUN pip install poetry==1.8.3
COPY pyproject.toml poetry.lock* ./
RUN poetry install --no-root --no-interaction

COPY . .

CMD ["poetry", "run", "python", "-m", "src.main"]
