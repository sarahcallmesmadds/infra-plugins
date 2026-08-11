#!/bin/sh
# Records when a hook interpreter cannot be found, so a hook failure names
# itself instead of being reconstructed later.
#
# The 2026-08-07 queue entry said only that a UserPromptSubmit hook failed with
# exit code 127, which means a command could not be found, and that the command
# was not known. Identifying it took a full session four days later, and the
# answer was still short of proof. Two commands run on UserPromptSubmit on that
# machine: build-loop's notice-correction.js, which needs `node` on PATH, and
# cmux's status hook, which resolves a binary through an environment variable
# and falls back to a bare `cmux`. Either can produce a 127. Nothing recorded
# which one did, because Claude Code does not write UserPromptSubmit hook runs
# to the transcript at all.
#
# THIS IS DELIBERATELY NOT NODE. Every other hook here is, and none of them can
# report the failure this exists to catch: a node script cannot tell you that
# node is missing. /bin/sh is on every machine that can run a hook at all, so
# this is the one probe that still runs when the thing under test is gone.
#
# It writes only on a change of state, the same rule as the core-tools monitor:
# once when something breaks, silence while it stays broken, once when it comes
# back. A probe that appends on every prompt while a session is broken produces
# thousands of identical lines and gets deleted rather than read.
#
# A change is judged per conversation, against the last line this session wrote.
# The state being reported is a property of one session's environment, so a
# healthy session starting beside a broken one is not a recovery, and a session
# that has recorded nothing yet has nothing to have changed from.
#
# It never blocks and never speaks. UserPromptSubmit adds a hook's stdout to the
# conversation, so anything printed here would land in the context of every
# prompt for the sake of a diagnostic nobody asked for. It stays silent and
# leaves a file behind.

# Consume the event. A hook that leaves stdin unread can take SIGPIPE when the
# writer closes, which turns a diagnostic into a second fault.
#
# Read with the shell itself. The event carries the session id that separates
# one conversation's state from another, so losing it when PATH cannot resolve
# `cat` collapses every broken conversation into the shared `unknown` lane and
# lets them trade duplicate lines. Newlines are immaterial to the field lookup,
# but the loop consumes the whole event so the writer can close cleanly.
event=""
while IFS= read -r event_line || [ -n "${event_line}" ]; do
    event="${event}${event_line}"
done

log_dir="${HOME}/.claude/build-loop"
log="${log_dir}/hook-health.log"

missing=""
command -v node >/dev/null 2>&1 || missing="${missing}node "

# cmux is only relevant on a machine running inside it. Reporting it absent
# everywhere else would mean every prompt on a plain terminal writes a line
# about software the user has not installed.
inside_cmux=""
[ -n "${CMUX_CLAUDE_HOOK_CMUX_BIN}" ] && inside_cmux=1
[ -n "${CMUX_CLAUDE_PID}" ] && inside_cmux=1

cmux_state="n/a"
if [ -n "${inside_cmux}" ]; then
    if [ -z "${CMUX_CLAUDE_HOOK_CMUX_BIN}" ]; then
        # The wrapper exports this at launch and its own hooks fall back to a
        # bare `cmux` when it is empty. Unset here means that fallback is live.
        cmux_state="unset"
        command -v cmux >/dev/null 2>&1 || missing="${missing}cmux "
    elif [ -x "${CMUX_CLAUDE_HOOK_CMUX_BIN}" ]; then
        cmux_state="ok"
    else
        # An absolute path that no longer resolves, which 127s on every prompt
        # until the session restarts.
        #
        # This cannot be inherited into a new session: the cmux wrapper runs
        # `export CMUX_CLAUDE_HOOK_CMUX_BIN="$(resolve_hook_cmux_bin)"` at every
        # launch, and a value set in the parent environment is overwritten.
        # Measured on 2026-08-11 by setting it to a missing path and reading it
        # back from inside a hook, which saw the resolved path instead. So a
        # stale value means the bundle was replaced while this session was
        # already running, not that a bad value was passed in.
        cmux_state="stale"
        missing="${missing}cmux "
    fi
fi

# Nothing wrong and nothing previously wrong: the common case, and it does no
# work beyond the two lookups above.
if [ -z "${missing}" ] && [ ! -f "${log}" ]; then
    exit 0
fi

state="missing=[${missing}] cmux_bin=${cmux_state}"

# Session id, so a line points back at the conversation it came from. Best
# effort: this is a diagnostic, and a missing id is not worth a JSON parser in
# a shell script.
#
# Shell expansions rather than sed and head. Everything from here to the write
# has to work when nothing resolves, because the id decides which lane the
# change-of-state check reads and a broken lane means a line per prompt. It also
# takes the first "session_id" in the event where the sed took the last, since
# `.*` is greedy, and the first one is the field rather than something quoted
# back inside a prompt.
sid=""
case "${event}" in
    *'"session_id"'*)
        sid="${event#*\"session_id\"}"
        sid="${sid#*:}"
        sid="${sid#*\"}"
        sid="${sid%%\"*}"
        ;;
esac
[ -n "${sid}" ] || sid="unknown"

# The last line this session wrote, and nothing else. State belongs to a
# conversation, not to the machine: two sessions can share a HOME and disagree,
# one running inside cmux and one not, or one started before an update that
# moved node. Comparing against whichever line happened to land last made each
# of them read as a transition away from the other, so a persistent fault in
# one session wrote a line per prompt while the other kept undoing it.
#
# Sessions whose id could not be parsed share the `unknown` lane and can still
# talk over each other. That is the honest limit of a diagnostic that does not
# carry a JSON parser, and it is quieter than the alternative.
#
# Read with the shell's own `read`, not with grep and tail. This was a pipeline
# of both, which is a change-of-state check that asks two external commands
# whether the state has changed. On a PATH broken badly enough to lose them the
# substitution came back empty, nothing ever matched, and the probe appended the
# same line on every prompt, on exactly the machine it was written for. A
# diagnostic must not depend on the health of the thing it is diagnosing.
#
# The cost is reading the file each prompt instead of spawning two processes.
# The file holds one line per change of state, so it is a handful of lines on
# any machine where this logic is working, and where it is not, that is the
# defect rather than the file size.
last=""
if [ -f "${log}" ]; then
    # Silence the redirection itself, not only commands inside the loop. If the
    # file exists but cannot be read, there is no trustworthy previous state to
    # compare with, so leave without speaking or attempting another write.
    if ! while IFS= read -r line || [ -n "${line}" ]; do
        case "${line}" in
            *"session=${sid} "*) last="${line}" ;;
        esac
    done 2>/dev/null < "${log}"; then
        exit 0
    fi
fi

# Only on a change.
case "${last}" in
    *" ${state}"*) exit 0 ;;
esac

# A recovery needs a failure to recover from, and it has to be this session's
# failure. This used to ask whether the file had ever held one, anywhere, which
# meant every new healthy session after any past failure filed a recovery of its
# own, and then so did the next one, forever. The transition the log exists to
# make visible was the thing being buried.
if [ -z "${missing}" ]; then
    case "${last}" in
        *" MISSING "*) ;;
        *) exit 0 ;;
    esac
fi

# Only when it is not already there. `mkdir` is a command like any other, so on
# the badly broken PATH this file exists to describe it is missing too, and
# `mkdir -p ... || exit 0` then threw away the report on the one machine most in
# need of it. The directory usually exists, and `printf` is a shell builtin, so
# skipping the call means the write still lands when nothing else on the system
# can be found.
if [ ! -d "${log_dir}" ]; then
    mkdir -p "${log_dir}" 2>/dev/null || exit 0
fi

stamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
# `date` can be missing for the same reason. A line with no timestamp is worth
# more than no line, and a blank field would silently shift the ones after it.
[ -n "${stamp}" ] || stamp="time-unknown"

# PATH goes on a failure line and only on a failure line. Exit 127 means a
# command could not be found, so the list of places that were searched is the
# evidence, and without it the line names a symptom and no cause. On a recovery
# it explains nothing, so it is left off there.
#
# What goes on the failure line is the search path and not the machine. This
# file is one somebody pastes into a bug report, and a username is no part of
# the diagnosis, so the home directory is masked below.
#
# ORDER MATTERS IN BOTH WRITES BELOW. `2>/dev/null` comes before `>> "${log}"`,
# not after it. A shell applies redirections left to right, so with the append
# written first the append is attempted while stderr is still the inherited one,
# and a log file that cannot be written prints "Permission denied" from a probe
# that promises never to speak. It fires on exactly the machine least able to
# absorb it: one where the log was left owned by root by a single run under
# sudo, where every prompt from then on carries a complaint about a diagnostic
# nobody asked for.
if [ -z "${missing}" ]; then
    printf '%s RECOVERED session=%s %s\n' \
        "${stamp}" "${sid}" "${state}" 2>/dev/null >> "${log}"
else
    # The home directory is reduced to ~, entry by entry. A username and a home
    # layout identify whose machine this is and diagnose nothing, while the
    # directories on either side of them are the whole evidence, so the two come
    # apart cleanly and only one of them needs to be here.
    #
    # Done in the shell rather than with sed, which was the first attempt. HOME
    # is data, and inside a sed expression data is a regular expression: a home
    # directory containing a bracket made sed exit with "unbalanced brackets" on
    # stderr, and a probe whose whole contract is that it never speaks had
    # started speaking, on the one path where a session is already broken. A
    # case pattern in quotes is matched literally, so nothing here reads as a
    # pattern and no fallback is needed.
    logged_path=""
    first_path_entry=1
    remaining_path="${PATH}:"
    while [ -n "${remaining_path}" ]; do
        dir="${remaining_path%%:*}"
        remaining_path="${remaining_path#*:}"
        case "${HOME}" in
            ""|/) ;;
            *)
                case "${dir}" in
                    "${HOME}") dir="~" ;;
                    "${HOME}"/*) dir="~${dir#"${HOME}"}" ;;
                esac
                ;;
        esac
        if [ -n "${first_path_entry}" ]; then
            logged_path="${dir}"
            first_path_entry=""
        else
            logged_path="${logged_path}:${dir}"
        fi
    done

    printf '%s MISSING session=%s %s path=%s\n' \
        "${stamp}" "${sid}" "${state}" "${logged_path}" 2>/dev/null >> "${log}"
fi

exit 0
