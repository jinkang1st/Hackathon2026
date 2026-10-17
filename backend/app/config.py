from pathlib import Path

from pydantic import Field, HttpUrl, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[1] / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
    )

    nebius_api_key: SecretStr = SecretStr("")
    nebius_base_url: HttpUrl = HttpUrl("https://api.tokenfactory.nebius.com/v1/")
    nebius_model: str = Field(default="openai/gpt-oss-120b", min_length=1, max_length=200)
    nebius_timeout_seconds: float = Field(default=30, gt=0, le=120)
    nebius_max_retries: int = Field(default=1, ge=0, le=3)
    firewall_api_token: SecretStr = SecretStr("")
    firewall_cors_origins: list[str] = Field(default_factory=list)

    @field_validator("nebius_base_url")
    @classmethod
    def require_https(cls, value: HttpUrl) -> HttpUrl:
        if (
            value.scheme != "https"
            or value.username
            or value.password
            or value.query
            or value.fragment
        ):
            raise ValueError(
                "NEBIUS_BASE_URL must be an HTTPS URL without credentials/query/fragment"
            )
        return value
