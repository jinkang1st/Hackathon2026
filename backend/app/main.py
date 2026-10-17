import secrets
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from openai.types.chat import ChatCompletion

from app.config import Settings
from app.errors import ModelServiceError
from app.firewall_models import AssessmentRequest, AssessmentResponse
from app.models import ChatRequest
from app.providers.nebius import NebiusProvider
from app.services.firewall import FirewallService
from app.services.model import ModelService

bearer = HTTPBearer(auto_error=False)


def get_model_service(request: Request) -> ModelService:
    return request.app.state.model_service


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings if settings is not None else Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(follow_redirects=False) as client:
            app.state.model_service = ModelService(NebiusProvider(config, client))
            yield

    app = FastAPI(title="AI Firewall Model API", version="0.1.0", lifespan=lifespan)
    if config.firewall_cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=config.firewall_cors_origins,
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "Content-Type"],
            expose_headers=["X-Request-ID"],
        )

    @app.middleware("http")
    async def request_id(request: Request, call_next):
        request.state.request_id = str(uuid4())
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    def error_response(request: Request, status: int, code: str, message: str):
        return JSONResponse(
            status_code=status,
            content={
                "error": {
                    "code": code,
                    "message": message,
                    "param": None,
                    "type": "invalid_request_error"
                    if status in (400, 401, 422)
                    else "rate_limit_error"
                    if status == 429
                    else "server_error",
                }
            },
        )

    @app.exception_handler(ModelServiceError)
    async def model_error_handler(request: Request, exc: ModelServiceError):
        return error_response(request, exc.status_code, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        # Pydantic's default errors echo the input (possibly private drafts or credentials).
        return error_response(
            request, 400, "invalid_request", "Invalid request fields. See /docs for the API schema."
        )

    async def authorize(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    ):
        token = config.firewall_api_token.get_secret_value()
        if token and (
            credentials is None
            or not secrets.compare_digest(credentials.credentials.encode(), token.encode())
        ):
            raise ModelServiceError(
                "unauthorized", "The backend access token is missing or invalid.", 401
            )

    @app.get("/health")
    async def health():
        # Liveness/configuration only; no network request and no inference charge.
        return {
            "status": "ok",
            "model_configured": bool(config.nebius_api_key.get_secret_value().strip()),
        }

    @app.get("/v1/models", dependencies=[Depends(authorize)])
    async def models():
        return {
            "object": "list",
            "data": [
                {
                    "id": config.nebius_model,
                    "object": "model",
                    "created": 0,
                    "owned_by": "nebius",
                }
            ],
        }

    @app.post(
        "/v1/chat/completions", response_model=ChatCompletion, dependencies=[Depends(authorize)]
    )
    async def chat(
        body: ChatRequest,
        service: Annotated[ModelService, Depends(get_model_service)],
    ):
        return await service.chat.completions.create(**body.model_dump(exclude_none=True))

    @app.post(
        "/api/v1/firewall/assess",
        response_model=AssessmentResponse,
        dependencies=[Depends(authorize)],
    )
    async def assess(
        body: AssessmentRequest,
        service: Annotated[ModelService, Depends(get_model_service)],
    ):
        return await FirewallService(service).assess(body)

    return app


app = create_app()
