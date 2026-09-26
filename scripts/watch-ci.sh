#!/bin/bash
# 盯 CI 到出结果 —— 逐 job 判绿（只看 confluence/conclusion 会被单条 success 误触发）。
# 用法: bash scripts/watch-ci.sh [<sha>]     默认当前 HEAD
# 环境: CC_REPO（默认 miku-hermes/cc-manage）、CC_GH_TOKEN_FILE（默认 /tmp/.gh_user_token）、CC_WAIT_STEPS（默认 20，每步 20s）
# 注意: jobs/<id>/logs 需要高权限 token（repo-scoped PAT 会 403 Must have admin rights），列表端点两条都能读。
set -u
SHA="${1:-$(git rev-parse HEAD 2>/dev/null)}"
REPO="${CC_REPO:-miku-hermes/cc-manage}"
TOK="$(cat "${CC_GH_TOKEN_FILE:-/tmp/.gh_user_token}" 2>/dev/null || true)"
STEPS="${CC_WAIT_STEPS:-20}"
TMP="${TMPDIR:-/tmp}/cc-ci-watch.$$"
mkdir -p "$TMP"

api() { # api <path> <outfile>
  if [ -n "$TOK" ]; then
    curl -sS -H "Authorization: Bearer $TOK" -H 'Accept: application/vnd.github+json' "$1" -o "$2"
  else
    curl -sS -H 'Accept: application/vnd.github+json' "$1" -o "$2"
  fi
}

for i in $(seq 1 "$STEPS"); do
  api "https://api.github.com/repos/$REPO/actions/runs?per_page=6" "$TMP/runs.json"
  RUN=$(node -e 'const j=require(process.argv[1]);const r=(j.workflow_runs||[]).find(x=>x.head_sha===process.argv[2]);console.log(r?[r.status,r.conclusion||"-",r.id].join("|"):"notfound|-|-")' "$TMP/runs.json" "$SHA")
  STATUS=$(echo "$RUN" | cut -d'|' -f1)
  if [ "$STATUS" = "completed" ]; then
    RUNID=$(echo "$RUN" | cut -d'|' -f3)
    echo "SHA=$SHA run=$RUNID conclusion=$(echo "$RUN" | cut -d'|' -f2)"
    api "https://api.github.com/repos/$REPO/actions/runs/$RUNID/jobs" "$TMP/jobs.json"
    node -e '
      const j=require(process.argv[1]);
      let bad=[];
      for (const job of (j.jobs||[])) {
        console.log(`  ${job.conclusion==="success"?"OK":"FAIL"} ${job.name} (${job.conclusion||job.status})`);
        for (const s of (job.steps||[])) if (s.conclusion==="failure") { console.log(`      x ${s.name}`); bad.push(job.id); }
      }
      if (bad.length) console.log("FAILED_JOB_IDS="+[...new Set(bad)].join(","));
    ' "$TMP/jobs.json"
    FAILED=$(node -e 'const j=require(process.argv[1]);const b=[];for(const job of (j.jobs||[]))for(const s of (job.steps||[]))if(s.conclusion==="failure"){b.push(job.id);break}console.log([...new Set(b)].join(","))' "$TMP/jobs.json")
    if [ -n "$FAILED" ]; then
      for JID in $(echo "$FAILED" | tr ',' ' '); do
        echo "--- job $JID 日志（not ok / # fail）---"
        curl -sSL -H "Authorization: Bearer $TOK" -H 'Accept: application/vnd.github+json' \
          "https://api.github.com/repos/$REPO/actions/jobs/$JID/logs" -o "$TMP/log.txt"
        if grep -q 'Must have admin rights' "$TMP/log.txt" 2>/dev/null; then
          echo "  !! 日志被拒（403 Must have admin rights）—— 换 CC_GH_TOKEN_FILE 指向高权限 token 重试"
        else
          grep -nE 'not ok|^# fail|# fail [1-9]|ENOENT|Error:' "$TMP/log.txt" | head -20
        fi
      done
    fi
    rm -rf "$TMP"
    exit 0
  fi
  sleep 20
done
echo "CI 仍未完成（已等 $((STEPS*20))s）；可再跑一次本脚本"
rm -rf "$TMP"
