"""Read-only Google Classroom tools for an OpenDots Dot.

Courses the owner takes, their coursework with due dates and the owner's own
submission state, and recent announcements. Runs as a Streamable HTTP MCP
server on 127.0.0.1; OpenDots connects to it as a Dot connection.

    python server.py auth    # one-time consent (needs a browser on the callback port)
    python server.py serve   # the MCP server
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fastmcp import FastMCP
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/classroom.announcements.readonly",
]
DONE = {"TURNED_IN", "RETURNED"}
READ_ONLY = {"readOnlyHint": True, "openWorldHint": True}


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if not value:
        sys.exit(f"{name} is not set.")
    return value


ACCOUNT = env("CLASSROOM_ACCOUNT")
CLIENT_SECRET = env("GOOGLE_CLIENT_SECRET_PATH")
TOKEN_DIR = Path(env("CLASSROOM_TOKEN_DIR"))
LOCAL = ZoneInfo(os.environ.get("CLASSROOM_TIMEZONE", "Asia/Tokyo"))


def token_path() -> Path:
    return TOKEN_DIR / f"{ACCOUNT}.json"


def save(creds: Credentials) -> None:
    TOKEN_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = token_path()
    path.write_text(creds.to_json())
    path.chmod(0o600)


def credentials() -> Credentials:
    path = token_path()
    if not path.exists():
        raise RuntimeError(
            f"Classroom is not authorized for {ACCOUNT}. Tell the owner it needs the one-time authorization."
        )
    creds = Credentials.from_authorized_user_file(str(path), SCOPES)
    if not creds.valid:
        creds.refresh(Request())
        save(creds)
    return creds


def classroom():
    return build("classroom", "v1", credentials=credentials(), cache_discovery=False)


def pages(request_for, key: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    token = None
    while True:
        response = request_for(token).execute()
        items.extend(response.get(key, []))
        token = response.get("nextPageToken")
        if not token:
            return items


def due_at(work: dict[str, Any]) -> datetime | None:
    date = work.get("dueDate")
    if not date:
        return None
    time = work.get("dueTime", {})
    return datetime(
        date["year"],
        date["month"],
        date["day"],
        time.get("hours", 23),
        time.get("minutes", 59),
        tzinfo=timezone.utc,
    ).astimezone(LOCAL)


def active_courses(service) -> list[dict[str, Any]]:
    return pages(
        lambda token: service.courses().list(
            studentId="me", courseStates=["ACTIVE"], pageSize=100, pageToken=token
        ),
        "courses",
    )


mcp = FastMCP("classroom")


@mcp.tool(title="List courses", annotations=READ_ONLY)
def list_courses() -> list[dict[str, Any]]:
    """Active Google Classroom courses the owner takes (school account)."""
    return [
        {
            "id": course["id"],
            "name": course.get("name"),
            "section": course.get("section"),
            "link": course.get("alternateLink"),
        }
        for course in active_courses(classroom())
    ]


@mcp.tool(title="List assignments", annotations=READ_ONLY)
def list_assignments(
    course_id: str | None = None,
    include_done: bool = False,
    overdue_days: int = 30,
) -> list[dict[str, Any]]:
    """Coursework with due dates and the owner's own submission state.

    By default only work not yet turned in, including overdue work from the
    last `overdue_days` days, ordered by due date (undated last). States:
    NEW/CREATED = not submitted, TURNED_IN = submitted, RETURNED = graded and
    returned, RECLAIMED_BY_STUDENT = unsubmitted again.
    """
    service = classroom()
    courses = active_courses(service)
    if course_id:
        courses = [course for course in courses if course["id"] == course_id]
    now = datetime.now(LOCAL)
    oldest = now - timedelta(days=max(overdue_days, 0))
    rows: list[dict[str, Any]] = []
    for course in courses:
        works = pages(
            lambda token: service.courses()
            .courseWork()
            .list(
                courseId=course["id"],
                courseWorkStates=["PUBLISHED"],
                pageSize=100,
                pageToken=token,
            ),
            "courseWork",
        )
        if not works:
            continue
        submissions = {
            item["courseWorkId"]: item
            for item in pages(
                lambda token: service.courses()
                .courseWork()
                .studentSubmissions()
                .list(
                    courseId=course["id"],
                    courseWorkId="-",
                    userId="me",
                    pageSize=100,
                    pageToken=token,
                ),
                "studentSubmissions",
            )
        }
        for work in works:
            submission = submissions.get(work["id"], {})
            state = submission.get("state", "NEW")
            due = due_at(work)
            if not include_done and state in DONE:
                continue
            if not include_done and due and due < oldest:
                continue
            rows.append(
                {
                    "course": course.get("name"),
                    "title": work.get("title"),
                    "due": due.isoformat(timespec="minutes") if due else None,
                    "overdue": bool(due and due < now and state not in DONE),
                    "state": state,
                    "late": submission.get("late", False),
                    "points": work.get("maxPoints"),
                    "grade": submission.get("assignedGrade"),
                    "type": work.get("workType"),
                    "link": work.get("alternateLink"),
                }
            )
    rows.sort(key=lambda row: (row["due"] is None, row["due"] or ""))
    return rows


@mcp.tool(title="Recent announcements", annotations=READ_ONLY)
def recent_announcements(days: int = 7, course_id: str | None = None) -> list[dict[str, Any]]:
    """Teachers' announcements from the last `days` days, newest first."""
    service = classroom()
    courses = active_courses(service)
    if course_id:
        courses = [course for course in courses if course["id"] == course_id]
    since = datetime.now(timezone.utc) - timedelta(days=max(days, 1))
    rows: list[dict[str, Any]] = []
    for course in courses:
        response = (
            service.courses()
            .announcements()
            .list(courseId=course["id"], announcementStates=["PUBLISHED"], pageSize=20)
            .execute()
        )
        for item in response.get("announcements", []):
            created = datetime.fromisoformat(item["creationTime"].replace("Z", "+00:00"))
            if created < since:
                continue
            rows.append(
                {
                    "course": course.get("name"),
                    "posted": created.astimezone(LOCAL).isoformat(timespec="minutes"),
                    "text": (item.get("text") or "")[:1500],
                    "link": item.get("alternateLink"),
                }
            )
    rows.sort(key=lambda row: row["posted"], reverse=True)
    return rows


def authorize() -> None:
    port = int(os.environ.get("CLASSROOM_AUTH_PORT", "8818"))
    flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRET, SCOPES)
    creds = flow.run_local_server(
        host="localhost",
        port=port,
        open_browser=False,
        login_hint=ACCOUNT,
        authorization_prompt_message="Open this URL to authorize Classroom:\n{url}\n",
        success_message="Classroom is authorized. You can close this tab.",
        access_type="offline",
        prompt="consent",
    )
    save(creds)
    print(f"Saved Classroom authorization for {ACCOUNT}.", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["auth", "serve"])
    args = parser.parse_args()
    if args.command == "auth":
        authorize()
        return
    mcp.run(
        transport="streamable-http",
        host="127.0.0.1",
        port=int(os.environ.get("CLASSROOM_MCP_PORT", "8819")),
        show_banner=False,
    )


if __name__ == "__main__":
    main()
