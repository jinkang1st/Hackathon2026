from typing import Annotated, Literal

from pydantic import Field, model_validator

from app.models import StrictModel, TokenUsage


class SensitiveTerm(StrictModel):
    term: str = Field(min_length=1, max_length=64)
    match_mode: Literal["word", "substring"]


class MessageAssessmentRequest(StrictModel):
    enabled: bool = False
    content: str = Field(min_length=1, max_length=4000)
    application: str | None = Field(default=None, max_length=200)
    recipient: str | None = Field(default=None, max_length=500)
    public: bool = False
    personal_principles: list[Annotated[str, Field(min_length=1, max_length=500)]] = Field(
        default_factory=list, max_length=10
    )


class ModelMessageAssessment(StrictModel):
    should_remind: bool
    reason: str = Field(
        min_length=1, max_length=1200, description="Explain the decision in English."
    )
    suggested_revision: str | None = Field(
        max_length=4000,
        description="Optional calmer English revision preserving the user's meaning.",
    )

    @model_validator(mode="after")
    def require_reason(self):
        if not self.reason.strip():
            raise ValueError("A non-empty assessment reason is required")
        return self


class MessageAssessmentResponse(StrictModel):
    status: Literal["disabled", "no_match", "assessed"]
    should_remind: bool
    reason: str
    matched_terms: list[str] = Field(default_factory=list)
    suggested_revision: str | None = None
    model: str | None = None
    usage: TokenUsage | None = None
