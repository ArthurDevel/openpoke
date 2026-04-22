"""Interaction Agent Runtime - handles LLM calls for user and agent turns."""

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from typing import Any, Dict, List, Optional, Set

from .agent import build_system_prompt, prepare_message_with_history
from .tools import ToolResult, get_tool_schemas, handle_tool_call
from ...config import get_settings
from ...services.conversation import (
    get_conversation_event_hub,
    get_conversation_log,
    get_current_request_id,
    reset_current_request_id,
    set_current_request_id,
    get_working_memory_log,
)
from ...openrouter_client import stream_chat_completion
from ...logging_config import logger


@dataclass
class InteractionResult:
    """Result from the interaction agent."""

    success: bool
    response: str
    error: Optional[str] = None
    execution_agents_used: int = 0


@dataclass
class _ToolCall:
    """Parsed tool invocation from an LLM response."""

    identifier: Optional[str]
    name: str
    arguments: Dict[str, Any]


@dataclass
class _LoopSummary:
    """Aggregate information produced by the interaction loop."""

    last_assistant_text: str = ""
    user_messages: List[str] = field(default_factory=list)
    tool_names: List[str] = field(default_factory=list)
    execution_agents: Set[str] = field(default_factory=set)


_STREAMABLE_TOOL_NAME = "send_message_to_user"
_STREAMABLE_MESSAGE_KEY = '"message"'


class _MessageStreamExtractor:
    """Extract the streaming string value of the `message` field from JSON tool args.

    Feeds accept partial JSON chunks as they arrive on the wire and return any newly
    available characters of the target string value. Handles backslash escapes and
    \\uXXXX unicode escapes.
    """

    def __init__(self) -> None:
        self._buffer = ""
        self._pos = 0
        self._state = "SCAN"
        self._unicode_buf = ""
        self._done = False

    @property
    def done(self) -> bool:
        return self._done

    def feed(self, chunk: str) -> str:
        if self._done or not chunk:
            return ""
        self._buffer += chunk
        out: List[str] = []

        while self._pos < len(self._buffer) and not self._done:
            if self._state == "SCAN":
                if not self._advance_to_value_start():
                    break
                continue

            ch = self._buffer[self._pos]
            if self._state == "IN_STRING":
                if ch == "\\":
                    self._state = "ESCAPE"
                    self._pos += 1
                elif ch == '"':
                    self._done = True
                    self._pos += 1
                else:
                    out.append(ch)
                    self._pos += 1
            elif self._state == "ESCAPE":
                if ch == "u":
                    self._state = "UNICODE"
                    self._unicode_buf = ""
                else:
                    escape_map = {
                        '"': '"', "\\": "\\", "/": "/",
                        "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t",
                    }
                    out.append(escape_map.get(ch, ch))
                    self._state = "IN_STRING"
                self._pos += 1
            elif self._state == "UNICODE":
                self._unicode_buf += ch
                self._pos += 1
                if len(self._unicode_buf) == 4:
                    try:
                        out.append(chr(int(self._unicode_buf, 16)))
                    except ValueError:
                        pass
                    self._unicode_buf = ""
                    self._state = "IN_STRING"
            else:
                break

        return "".join(out)

    def _advance_to_value_start(self) -> bool:
        idx = self._buffer.find(_STREAMABLE_MESSAGE_KEY, self._pos)
        if idx == -1:
            return False
        j = idx + len(_STREAMABLE_MESSAGE_KEY)
        while j < len(self._buffer) and self._buffer[j] in " \t\n\r":
            j += 1
        if j >= len(self._buffer):
            return False
        if self._buffer[j] != ":":
            self._pos = j
            return True
        j += 1
        while j < len(self._buffer) and self._buffer[j] in " \t\n\r":
            j += 1
        if j >= len(self._buffer):
            return False
        if self._buffer[j] != '"':
            self._pos = j
            return True
        self._pos = j + 1
        self._state = "IN_STRING"
        return True


class InteractionAgentRuntime:
    """Manages the interaction agent's request processing."""

    MAX_TOOL_ITERATIONS = 8

    # Initialize interaction agent runtime with settings and service dependencies
    def __init__(self) -> None:
        settings = get_settings()
        self.api_key = settings.openrouter_api_key
        self.model = settings.interaction_agent_model
        self.settings = settings
        self.conversation_log = get_conversation_log()
        self.working_memory_log = get_working_memory_log()
        self.event_hub = get_conversation_event_hub()
        self.tool_schemas = get_tool_schemas()
        self._t0: float = 0.0
        self._timings: List[Dict[str, Any]] = []
        self._iteration: int = 0

        if not self.api_key:
            raise ValueError(
                "OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable."
            )

    def _stamp(self, event: str, **kwargs: Any) -> int:
        """Record a timing event with ms since _t0. Returns the recorded dt_ms."""
        dt_ms = int((time.perf_counter() - self._t0) * 1000)
        entry: Dict[str, Any] = {"event": event, "dt_ms": dt_ms}
        entry.update(kwargs)
        self._timings.append(entry)
        return dt_ms

    # Main entry point for processing user messages through the LLM interaction loop
    async def execute(self, user_message: str, request_id: Optional[str] = None) -> InteractionResult:
        """Handle a user-authored message."""

        active_request_id = request_id or uuid4().hex
        request_token = set_current_request_id(active_request_id)
        self._t0 = time.perf_counter()
        self._timings = []
        self._iteration = 0
        self._stamp("execute_started", request_id=active_request_id)
        logger.info(
            "trace stage=execute_started request_id=%s dt_ms=0", active_request_id
        )
        system_prompt: str = ""
        messages: List[Dict[str, Any]] = []
        try:
            transcript_before = self._load_conversation_transcript()
            self.conversation_log.record_user_message(user_message)

            system_prompt = build_system_prompt()
            messages = prepare_message_with_history(
                user_message, transcript_before, message_type="user"
            )

            logger.info("Processing user message through interaction agent")
            summary = await self._run_interaction_loop(system_prompt, messages)

            final_response = self._finalize_response(summary)

            if final_response and not summary.user_messages:
                self.conversation_log.record_reply(final_response)

            return InteractionResult(
                success=True,
                response=final_response,
                execution_agents_used=len(summary.execution_agents),
            )

        except Exception as exc:
            logger.exception("Interaction agent failed: %s", exc)
            return InteractionResult(
                success=False,
                response="",
                error=str(exc),
            )
        finally:
            total_ms = self._stamp("execute_done")
            self._dump_transcript(
                request_id=active_request_id,
                trigger="user",
                system_prompt=system_prompt,
                messages=messages,
                user_input=user_message,
            )
            logger.info(
                "trace stage=execute_done request_id=%s dt_ms=%d",
                active_request_id,
                total_ms,
            )
            reset_current_request_id(request_token)

    # Handle incoming messages from execution agents and generate appropriate responses
    async def handle_agent_message(
        self, agent_message: str, request_id: Optional[str] = None
    ) -> InteractionResult:
        """Process a status update emitted by an execution agent."""

        active_request_id = request_id or uuid4().hex
        request_token = set_current_request_id(active_request_id)
        self._t0 = time.perf_counter()
        self._timings = []
        self._iteration = 0
        self._stamp("execute_started", request_id=active_request_id, trigger="agent")
        system_prompt: str = ""
        messages: List[Dict[str, Any]] = []
        try:
            transcript_before = self._load_conversation_transcript()
            self.conversation_log.record_agent_message(agent_message)

            system_prompt = build_system_prompt()
            messages = prepare_message_with_history(
                agent_message, transcript_before, message_type="agent"
            )

            logger.info("Processing execution agent results")
            summary = await self._run_interaction_loop(system_prompt, messages)

            final_response = self._finalize_response(summary)

            if final_response and not summary.user_messages:
                self.conversation_log.record_reply(final_response)

            return InteractionResult(
                success=True,
                response=final_response,
                execution_agents_used=len(summary.execution_agents),
            )

        except Exception as exc:
            logger.exception("Interaction agent (agent message) failed: %s", exc)
            return InteractionResult(
                success=False,
                response="",
                error=str(exc),
            )
        finally:
            self._stamp("execute_done")
            self._dump_transcript(
                request_id=active_request_id,
                trigger="agent",
                system_prompt=system_prompt,
                messages=messages,
                user_input=agent_message,
            )
            reset_current_request_id(request_token)

    # Core interaction loop that handles LLM calls and tool executions until completion
    async def _run_interaction_loop(
        self,
        system_prompt: str,
        messages: List[Dict[str, Any]],
    ) -> _LoopSummary:
        """Iteratively query the LLM until it issues a final response."""

        summary = _LoopSummary()

        for iteration in range(self.MAX_TOOL_ITERATIONS):
            self._iteration = iteration + 1
            self._stamp("iter_start", iter=self._iteration)
            assistant_message = await self._make_llm_call(system_prompt, messages)
            self._stamp("iter_llm_end", iter=self._iteration)

            assistant_content = (assistant_message.get("content") or "").strip()
            if assistant_content:
                summary.last_assistant_text = assistant_content

            raw_tool_calls = assistant_message.get("tool_calls") or []
            parsed_tool_calls = self._parse_tool_calls(raw_tool_calls)

            assistant_entry: Dict[str, Any] = {
                "role": "assistant",
                "content": assistant_message.get("content", "") or "",
            }
            if raw_tool_calls:
                assistant_entry["tool_calls"] = raw_tool_calls
            messages.append(assistant_entry)

            if not parsed_tool_calls:
                break

            for tool_call in parsed_tool_calls:
                summary.tool_names.append(tool_call.name)

                if tool_call.name == "send_message_to_agent":
                    agent_name = tool_call.arguments.get("agent_name")
                    if isinstance(agent_name, str) and agent_name:
                        summary.execution_agents.add(agent_name)

                self._stamp("tool_start", iter=self._iteration, tool=tool_call.name)
                result = self._execute_tool(tool_call)
                self._stamp(
                    "tool_end",
                    iter=self._iteration,
                    tool=tool_call.name,
                    success=result.success,
                )

                if result.user_message:
                    summary.user_messages.append(result.user_message)

                tool_message = {
                    "role": "tool",
                    "tool_call_id": tool_call.identifier or tool_call.name,
                    "content": self._format_tool_result(tool_call, result),
                }
                messages.append(tool_message)
        else:
            raise RuntimeError("Reached tool iteration limit without final response")

        if not summary.user_messages and not summary.last_assistant_text:
            logger.warning("Interaction loop exited without assistant content")

        return summary

    # Load conversation history, preferring summarized version if available
    def _load_conversation_transcript(self) -> str:
        if self.settings.summarization_enabled:
            rendered = self.working_memory_log.render_transcript()
            if rendered.strip():
                return rendered
        return self.conversation_log.load_transcript()

    # Execute API call to OpenRouter with system prompt, messages, and tool schemas
    async def _make_llm_call(
        self,
        system_prompt: str,
        messages: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Make a streaming LLM call via OpenRouter and reconstruct the assistant message."""

        logger.debug(
            "Interaction agent calling LLM",
            extra={"model": self.model, "tools": len(self.tool_schemas)},
        )
        assistant_content_parts: List[str] = []
        tool_calls_by_index: Dict[int, Dict[str, Any]] = {}
        published_reply_id: Optional[str] = None
        saw_tool_calls = False
        tool_stream_state: Dict[int, Dict[str, Any]] = {}
        saw_first_chunk = False

        def _publish_tool_delta(state: Dict[str, Any], text: str) -> None:
            if not text:
                return
            if not state.get("first_char_stamped"):
                state["first_char_stamped"] = True
                self._stamp(
                    "tool_first_streamed_char",
                    iter=self._iteration,
                    tool=_STREAMABLE_TOOL_NAME,
                )
            self.event_hub.publish(
                "assistant_delta",
                reply_id=state["reply_id"],
                request_id=get_current_request_id(),
                delta=text,
            )

        def _close_tool_stream(state: Dict[str, Any]) -> None:
            if state.get("closed"):
                return
            state["closed"] = True
            self.event_hub.publish(
                "assistant_done",
                reply_id=state["reply_id"],
                request_id=get_current_request_id(),
            )

        self._stamp("iter_llm_start", iter=self._iteration)
        async for chunk in stream_chat_completion(
            model=self.model,
            messages=messages,
            system=system_prompt,
            api_key=self.api_key,
            tools=self.tool_schemas,
        ):
            if not saw_first_chunk:
                saw_first_chunk = True
                self._stamp("iter_first_chunk", iter=self._iteration)
            choice = (chunk.get("choices") or [{}])[0]
            delta = choice.get("delta") or {}
            if not isinstance(delta, dict):
                continue

            content_delta = delta.get("content")
            if isinstance(content_delta, str) and content_delta:
                assistant_content_parts.append(content_delta)
                if not saw_tool_calls:
                    if published_reply_id is None:
                        published_reply_id = uuid4().hex
                        self._stamp(
                            "content_first_streamed_char", iter=self._iteration
                        )
                        self.event_hub.publish(
                            "assistant_start",
                            reply_id=published_reply_id,
                            request_id=get_current_request_id(),
                        )
                    self.event_hub.publish(
                        "assistant_delta",
                        reply_id=published_reply_id,
                        request_id=get_current_request_id(),
                        delta=content_delta,
                    )

            streamed_tool_calls = delta.get("tool_calls") or []
            if not isinstance(streamed_tool_calls, list):
                continue

            if streamed_tool_calls:
                saw_tool_calls = True
                if published_reply_id is not None:
                    self.event_hub.publish(
                        "assistant_abort",
                        reply_id=published_reply_id,
                        request_id=get_current_request_id(),
                    )
                    published_reply_id = None

            for raw_tool_call in streamed_tool_calls:
                if not isinstance(raw_tool_call, dict):
                    continue

                index = raw_tool_call.get("index")
                if not isinstance(index, int):
                    index = 0

                tool_call = tool_calls_by_index.setdefault(
                    index,
                    {
                        "id": raw_tool_call.get("id"),
                        "type": raw_tool_call.get("type") or "function",
                        "function": {"name": "", "arguments": ""},
                    },
                )

                if isinstance(raw_tool_call.get("id"), str):
                    tool_call["id"] = raw_tool_call["id"]
                if isinstance(raw_tool_call.get("type"), str):
                    tool_call["type"] = raw_tool_call["type"]

                function_delta = raw_tool_call.get("function") or {}
                if not isinstance(function_delta, dict):
                    continue

                name_delta = function_delta.get("name")
                if isinstance(name_delta, str) and name_delta:
                    tool_call["function"]["name"] += name_delta

                state = tool_stream_state.setdefault(
                    index,
                    {"enabled": False, "closed": False, "reply_id": None, "extractor": None},
                )

                current_name = tool_call["function"]["name"]
                if (
                    not state["enabled"]
                    and not state["closed"]
                    and current_name == _STREAMABLE_TOOL_NAME
                ):
                    state["enabled"] = True
                    state["reply_id"] = uuid4().hex
                    state["extractor"] = _MessageStreamExtractor()
                    self.event_hub.publish(
                        "assistant_start",
                        reply_id=state["reply_id"],
                        request_id=get_current_request_id(),
                    )
                    existing_args = tool_call["function"]["arguments"]
                    if existing_args:
                        _publish_tool_delta(state, state["extractor"].feed(existing_args))
                        if state["extractor"].done:
                            _close_tool_stream(state)

                arguments_delta = function_delta.get("arguments")
                if isinstance(arguments_delta, str) and arguments_delta:
                    tool_call["function"]["arguments"] += arguments_delta
                    if state["enabled"] and not state["closed"]:
                        _publish_tool_delta(state, state["extractor"].feed(arguments_delta))
                        if state["extractor"].done:
                            _close_tool_stream(state)

        if published_reply_id is not None:
            self.event_hub.publish(
                "assistant_done",
                reply_id=published_reply_id,
                request_id=get_current_request_id(),
            )

        for state in tool_stream_state.values():
            if state.get("enabled") and not state.get("closed"):
                _close_tool_stream(state)

        assistant_message: Dict[str, Any] = {
            "role": "assistant",
            "content": "".join(assistant_content_parts),
        }
        if tool_calls_by_index:
            assistant_message["tool_calls"] = [
                tool_calls_by_index[index] for index in sorted(tool_calls_by_index.keys())
            ]

        return assistant_message

    # Convert raw LLM tool calls into structured _ToolCall objects with validation
    def _parse_tool_calls(self, raw_tool_calls: List[Dict[str, Any]]) -> List[_ToolCall]:
        """Normalize tool call payloads from the LLM."""

        parsed: List[_ToolCall] = []
        for raw in raw_tool_calls:
            function_block = raw.get("function") or {}
            name = function_block.get("name")
            if not isinstance(name, str) or not name:
                logger.warning("Skipping tool call without name", extra={"tool": raw})
                continue

            arguments, error = self._parse_tool_arguments(function_block.get("arguments"))
            if error:
                logger.warning("Tool call arguments invalid", extra={"tool": name, "error": error})
                parsed.append(
                    _ToolCall(
                        identifier=raw.get("id"),
                        name=name,
                        arguments={"__invalid_arguments__": error},
                    )
                )
                continue

            parsed.append(
                _ToolCall(identifier=raw.get("id"), name=name, arguments=arguments)
            )

        return parsed

    # Parse and validate tool arguments from various formats (dict, JSON string, etc.)
    def _parse_tool_arguments(
        self, raw_arguments: Any
    ) -> tuple[Dict[str, Any], Optional[str]]:
        """Convert tool arguments into a dictionary, reporting errors."""

        if raw_arguments is None:
            return {}, None

        if isinstance(raw_arguments, dict):
            return raw_arguments, None

        if isinstance(raw_arguments, str):
            if not raw_arguments.strip():
                return {}, None
            try:
                parsed = json.loads(raw_arguments)
            except json.JSONDecodeError as exc:
                return {}, f"invalid json: {exc}"
            if isinstance(parsed, dict):
                return parsed, None
            return {}, "decoded arguments were not an object"

        return {}, f"unsupported argument type: {type(raw_arguments).__name__}"

    # Execute tool calls with error handling and logging, returning standardized results
    def _execute_tool(self, tool_call: _ToolCall) -> ToolResult:
        """Execute a tool call and convert low-level errors into structured results."""

        if "__invalid_arguments__" in tool_call.arguments:
            error = tool_call.arguments["__invalid_arguments__"]
            self._log_tool_invocation(tool_call, stage="rejected", detail={"error": error})
            return ToolResult(success=False, payload={"error": error})

        try:
            self._log_tool_invocation(tool_call, stage="start")
            result = handle_tool_call(tool_call.name, tool_call.arguments)
        except Exception as exc:  # pragma: no cover - defensive
            logger.error(
                "Tool execution crashed",
                extra={"tool": tool_call.name, "error": str(exc)},
            )
            self._log_tool_invocation(
                tool_call,
                stage="error",
                detail={"error": str(exc)},
            )
            return ToolResult(success=False, payload={"error": str(exc)})

        if not isinstance(result, ToolResult):
            logger.warning(
                "Tool did not return ToolResult; coercing",
                extra={"tool": tool_call.name},
            )
            wrapped = ToolResult(success=True, payload=result)
            self._log_tool_invocation(tool_call, stage="done", result=wrapped)
            return wrapped

        status = "success" if result.success else "error"
        logger.debug(
            "Tool executed",
            extra={
                "tool": tool_call.name,
                "status": status,
            },
        )
        self._log_tool_invocation(tool_call, stage="done", result=result)
        return result

    # Format tool execution results into JSON for LLM consumption
    def _format_tool_result(self, tool_call: _ToolCall, result: ToolResult) -> str:
        """Render a tool execution result back to the LLM."""

        payload: Dict[str, Any] = {
            "tool": tool_call.name,
            "status": "success" if result.success else "error",
            "arguments": {
                key: value
                for key, value in tool_call.arguments.items()
                if key != "__invalid_arguments__"
            },
        }

        if result.payload is not None:
            key = "result" if result.success else "error"
            payload[key] = result.payload

        return self._safe_json_dump(payload)

    # Safely serialize objects to JSON with fallback to string representation
    def _safe_json_dump(self, payload: Any) -> str:
        """Serialize payload to JSON, falling back to repr on failure."""

        try:
            return json.dumps(payload, default=str)
        except TypeError:
            return repr(payload)

    # Log tool execution stages (start, done, error) with structured metadata
    def _log_tool_invocation(
        self,
        tool_call: _ToolCall,
        *,
        stage: str,
        result: Optional[ToolResult] = None,
        detail: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Emit structured logs for tool lifecycle events."""

        cleaned_args = {
            key: value
            for key, value in tool_call.arguments.items()
            if key != "__invalid_arguments__"
        }

        log_payload: Dict[str, Any] = {
            "tool": tool_call.name,
            "stage": stage,
            "arguments": cleaned_args,
        }

        if result is not None:
            log_payload["success"] = result.success
            if result.payload is not None:
                log_payload["payload"] = result.payload

        if detail:
            log_payload.update(detail)

        if stage == "done":
            logger.info(f"Tool '{tool_call.name}' completed")
        elif stage in {"error", "rejected"}:
            logger.warning(f"Tool '{tool_call.name}' {stage}")
        else:
            logger.debug(f"Tool '{tool_call.name}' {stage}")

    # Determine final user-facing response from interaction loop summary
    def _finalize_response(self, summary: _LoopSummary) -> str:
        """Decide what text should be exposed to the user as the final reply."""

        if summary.user_messages:
            return summary.user_messages[-1]

        return summary.last_assistant_text

    TRANSCRIPT_DIR = Path(__file__).resolve().parents[2] / "data" / "llm_transcripts"
    SESSION_FILE = TRANSCRIPT_DIR / "session.md"
    SYSTEM_PROMPT_FILE = TRANSCRIPT_DIR / "system_prompt.md"

    def _dump_transcript(
        self,
        *,
        request_id: str,
        trigger: str,
        system_prompt: str,
        messages: List[Dict[str, Any]],
        user_input: str,
    ) -> None:
        """Append this turn's transcript (timings + messages) to the session file."""

        if not messages and not system_prompt:
            return

        try:
            self.TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)

            if system_prompt:
                existing = (
                    self.SYSTEM_PROMPT_FILE.read_text(encoding="utf-8")
                    if self.SYSTEM_PROMPT_FILE.exists()
                    else ""
                )
                if existing != system_prompt:
                    self.SYSTEM_PROMPT_FILE.write_text(system_prompt, encoding="utf-8")

            now = datetime.now(timezone.utc)
            preview = user_input.strip().splitlines()[0][:80] if user_input else ""
            lines: List[str] = [
                "",
                "---",
                "",
                f"## Turn — {now.isoformat()} — request_id=`{request_id}`",
                "",
                f"- trigger: `{trigger}`",
                f"- model: `{self.model}`",
                f"- iterations: {self._iteration}",
                f"- message count: {len(messages)}",
            ]
            if preview:
                lines.append(f"- input: {preview!r}")
            lines.extend(["", "### Timings (dt_ms from execute_started)", ""])
            lines.extend(self._render_timings_md())
            lines.extend(["", "### Messages", ""])
            for idx, msg in enumerate(messages):
                lines.extend(self._render_message_md(idx, msg))

            header_needed = not self.SESSION_FILE.exists()
            with self.SESSION_FILE.open("a", encoding="utf-8") as fh:
                if header_needed:
                    fh.write(
                        "# Interaction agent session log\n\n"
                        f"System prompt: see `{self.SYSTEM_PROMPT_FILE.name}` (overwritten when it changes).\n"
                    )
                fh.write("\n".join(lines))
                fh.write("\n")
            logger.info("LLM transcript appended to %s", self.SESSION_FILE)
        except Exception as exc:  # pragma: no cover - best-effort telemetry
            logger.warning("failed to dump LLM transcript: %s", exc)

    def _render_timings_md(self) -> List[str]:
        """Render the timings list as a markdown table."""
        if not self._timings:
            return ["_no timings recorded_"]

        lines = ["| dt_ms | event | detail |", "|-------|-------|--------|"]
        for t in self._timings:
            dt = t.get("dt_ms", "")
            event = t.get("event", "")
            detail_parts = [
                f"{k}=`{v}`"
                for k, v in t.items()
                if k not in {"event", "dt_ms"}
            ]
            detail = ", ".join(detail_parts) if detail_parts else ""
            lines.append(f"| {dt} | `{event}` | {detail} |")
        return lines

    def _render_message_md(self, idx: int, msg: Dict[str, Any]) -> List[str]:
        """Render a single chat message as markdown."""

        role = str(msg.get("role", "unknown"))
        lines: List[str] = [f"### [{idx}] {role}", ""]

        content = msg.get("content")
        if isinstance(content, str) and content.strip():
            lines.extend(["```", content, "```", ""])
        elif content:
            lines.extend(["```json", self._safe_json_dump(content), "```", ""])

        tool_calls = msg.get("tool_calls")
        if tool_calls:
            lines.append("**tool_calls:**")
            lines.append("")
            for tc in tool_calls:
                fn = (tc.get("function") or {}) if isinstance(tc, dict) else {}
                name = fn.get("name", "?")
                args_raw = fn.get("arguments", "")
                if isinstance(args_raw, str):
                    try:
                        args_pretty = json.dumps(json.loads(args_raw), indent=2)
                    except Exception:
                        args_pretty = args_raw
                else:
                    args_pretty = self._safe_json_dump(args_raw)
                call_id = tc.get("id") if isinstance(tc, dict) else None
                lines.append(f"- `{name}` (id=`{call_id}`)")
                lines.extend(["  ```json", args_pretty, "  ```"])
            lines.append("")

        tool_call_id = msg.get("tool_call_id")
        if tool_call_id:
            lines.append(f"*tool_call_id:* `{tool_call_id}`")
            lines.append("")

        return lines
