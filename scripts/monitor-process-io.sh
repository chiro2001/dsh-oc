#!/usr/bin/env bash
# Low-overhead Linux process I/O/CPU/RSS observer.
#
# Observe an existing, explicitly supplied PID:
#   scripts/monitor-process-io.sh --pid 1234 --log /tmp/io.tsv --samples 10
#
# Or let this script own the process group it starts (the only mode in which
# termination is permitted):
#   scripts/monitor-process-io.sh --start --terminate-owned --log io.tsv -- command args...
#
# Default mode is observe-only. The script never kills an externally supplied
# PID, even when thresholds are exceeded. Thresholds only print warnings and
# sampling continues.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  monitor-process-io.sh --pid PID --log FILE [options]
  monitor-process-io.sh --start [--terminate-owned] --log FILE [options] -- COMMAND [ARG...]

options:
  --interval SEC             Sampling interval (default: 1)
  --samples N                Stop after N samples (default: continuous)
  --include-descendants      Include verifiable /proc descendants in totals
  --read-threshold BYTES    Warn when read_bytes delta reaches this value
  --write-threshold BYTES   Warn when write_bytes delta reaches this value
  --rchar-threshold BYTES   Warn when rchar delta reaches this value
  --wchar-threshold BYTES   Warn when wchar delta reaches this value
  --cpu-threshold JIFFIES   Warn when CPU jiffies delta reaches this value
  --rss-threshold BYTES     Warn when aggregate RSS reaches this value
  --terminate-owned          Only valid with --start; terminate owned PGID on exit
  -h, --help                 Show this help
EOF
}

pid=''
log_file=''
interval='1'
samples=''
include_descendants=0
terminate_owned=0
start_owned=0
read_threshold=''
write_threshold=''
rchar_threshold=''
wchar_threshold=''
cpu_threshold=''
rss_threshold=''
command=()

die() { echo "monitor-process-io: $*" >&2; exit 2; }
is_uint() [[ "${1:-}" =~ ^[0-9]+$ ]]

while (($# > 0)); do
  case "$1" in
    --pid)
      (($# >= 2)) || die '--pid requires a PID'
      pid=$2; shift 2
      ;;
    --log)
      (($# >= 2)) || die '--log requires a file path'
      log_file=$2; shift 2
      ;;
    --interval)
      (($# >= 2)) || die '--interval requires seconds'
      interval=$2; shift 2
      ;;
    --samples)
      (($# >= 2)) || die '--samples requires a count'
      samples=$2; shift 2
      ;;
    --include-descendants) include_descendants=1; shift ;;
    --terminate-owned) terminate_owned=1; shift ;;
    --start)
      start_owned=1; shift
      ;;
    --read-threshold) (($# >= 2)) || die '--read-threshold requires bytes'; read_threshold=$2; shift 2 ;;
    --write-threshold) (($# >= 2)) || die '--write-threshold requires bytes'; write_threshold=$2; shift 2 ;;
    --rchar-threshold) (($# >= 2)) || die '--rchar-threshold requires bytes'; rchar_threshold=$2; shift 2 ;;
    --wchar-threshold) (($# >= 2)) || die '--wchar-threshold requires bytes'; wchar_threshold=$2; shift 2 ;;
    --cpu-threshold) (($# >= 2)) || die '--cpu-threshold requires jiffies'; cpu_threshold=$2; shift 2 ;;
    --rss-threshold) (($# >= 2)) || die '--rss-threshold requires bytes'; rss_threshold=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; command=("$@"); break ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$log_file" ]] || die '--log is required'
[[ -n "$pid" || "$start_owned" == 1 ]] || die 'choose --pid PID or --start -- COMMAND'
[[ -z "$pid" || "$start_owned" == 0 ]] || die '--pid cannot be combined with --start'
[[ "$terminate_owned" == 0 || "$start_owned" == 1 ]] || die '--terminate-owned is only allowed with --start'
if [[ "$start_owned" == 1 && ${#command[@]} -eq 0 ]]; then die '--start requires -- COMMAND [ARG...]'; fi
[[ "$interval" =~ ^[0-9]+([.][0-9]+)?$ ]] || die 'interval must be a positive number'
awk -v value="$interval" 'BEGIN {exit !(value > 0)}' || die 'interval must be greater than zero'
if [[ -n "$samples" ]]; then is_uint "$samples" || die 'samples must be a non-negative integer'; fi
for value in "$read_threshold" "$write_threshold" "$rchar_threshold" "$wchar_threshold" "$cpu_threshold" "$rss_threshold"; do
  [[ -z "$value" || "$value" =~ ^[0-9]+$ ]] || die 'thresholds must be non-negative integers'
done

owned_pgid=''
owned_sid=''
owned_starttime=''
owned_identity_ok=0
owned_cleanup_done=0

proc_identity() {
  local sample_pid=$1
  local file="/proc/$sample_pid/stat" line rest
  [[ -r "$file" ]] || return 1
  line="$(<"$file")"
  rest="${line##*) }"
  [[ "$rest" != "$line" ]] || return 1
  local -a fields=()
  read -r -a fields <<< "$rest" || return 1
  # post-comm fields: pgrp=field 5 -> index 2, session=field 6 -> index 3,
  # starttime=field 22 -> index 19.
  echo "${fields[2]:-} ${fields[3]:-} ${fields[19]:-}"
}

proc_group_members() {
  [[ "$owned_identity_ok" == 1 && -n "$owned_pgid" && -n "$owned_sid" ]] || return 0
  local entry sample_pid identity pgrp sid
  for entry in /proc/[0-9]*; do
    sample_pid=${entry##*/}
    [[ "$sample_pid" =~ ^[0-9]+$ ]] || continue
    identity="$(proc_identity "$sample_pid" 2>/dev/null || true)"
    read -r pgrp sid _ <<< "$identity"
    [[ "$pgrp" == "$owned_pgid" && "$sid" == "$owned_sid" ]] && echo "$sample_pid"
  done
}

cleanup_owned() {
  if [[ "$terminate_owned" != 1 || "$owned_cleanup_done" == 1 ]]; then return; fi
  owned_cleanup_done=1
  if [[ "$owned_identity_ok" != 1 || -z "$owned_pgid" ]]; then
    echo "monitor-process-io WARNING owned process identity was not verified; group termination disabled" >&2
    return
  fi
  kill -TERM -- "-$owned_pgid" 2>/dev/null || true
  local remaining=''
  for _ in $(seq 1 20); do
    remaining="$(proc_group_members || true)"
    [[ -z "$remaining" ]] && return
    sleep 0.1
  done
  kill -KILL -- "-$owned_pgid" 2>/dev/null || true
  sleep 0.1
  remaining="$(proc_group_members || true)"
  if [[ -n "$remaining" ]]; then
    echo "monitor-process-io WARNING owned process group remained after KILL: $remaining" >&2
  fi
}
on_signal() {
  exit 143
}
trap cleanup_owned EXIT
trap on_signal INT TERM

if [[ "$start_owned" == 1 ]]; then
  # setsid creates a process group whose ID is the child PID. No external PID
  # can enter this branch because --start and --terminate-owned are explicit.
  setsid -- "${command[@]}" &
  pid=$!
  owned_pgid="$pid"
  sleep 0.05
  identity="$(proc_identity "$pid" 2>/dev/null || true)"
  read -r actual_pgid actual_sid owned_starttime <<< "$identity"
  if [[ "$actual_pgid" == "$pid" && "$actual_sid" == "$pid" && "$owned_starttime" =~ ^[0-9]+$ ]]; then
    owned_sid="$actual_sid"
    owned_identity_ok=1
  else
    echo "monitor-process-io WARNING setsid identity verification failed (pid=$pid pgid=${actual_pgid:-?} sid=${actual_sid:-?}); group termination disabled" >&2
  fi
fi

[[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 0 ]] || die 'PID must be a positive integer'
if [[ ! -r "/proc/$pid/io" || ! -r "/proc/$pid/stat" ]]; then
  if [[ "$start_owned" == 1 ]]; then
    if wait "$pid"; then owned_exit_code=0; else owned_exit_code=$?; fi
    owned_natural_exit=1
    exit "$owned_exit_code"
  fi
  die "PID $pid is not readable under /proc"
fi
mkdir -p "$(dirname "$log_file")"

external_starttime=''
if [[ "$start_owned" == 0 ]]; then
  identity="$(proc_identity "$pid" 2>/dev/null || true)"
  read -r _ _ external_starttime <<< "$identity"
  [[ "$external_starttime" =~ ^[0-9]+$ ]] || die "PID $pid identity could not be established"
fi

page_size="$(getconf PAGESIZE 2>/dev/null || echo 4096)"
clock_tick="$(getconf CLK_TCK 2>/dev/null || echo 100)"
printf 'timestamp\troot_pid\tpids\tread_bytes_current\twrite_bytes_current\trchar_current\twchar_current\trss_bytes\tread_delta\twrite_delta\trchar_delta\twchar_delta\tcpu_jiffies_delta\tcpu_jiffies_total\tcpu_percent\n' > "$log_file"

proc_children() {
  local current=$1 child
  [[ -r "/proc/$current/task/$current/children" ]] || return 0
  read -r -a children < "/proc/$current/task/$current/children" || true
  for child in "${children[@]:-}"; do
    [[ "$child" =~ ^[0-9]+$ ]] || continue
    echo "$child"
    proc_children "$child"
  done
}

pid_set() {
  if [[ -d "/proc/$pid" ]]; then
    printf '%s\n' "$pid"
    if [[ "$include_descendants" == 1 ]]; then proc_children "$pid"; fi
  elif [[ "$start_owned" == 1 && "$owned_identity_ok" == 1 ]]; then
    # The setsid root can exit before a child in the same owned session. Keep
    # observing that verified process group instead of treating the root exit
    # as completion or subtracting the child's counters.
    proc_group_members
  fi
}

read_counter() {
  local field=$1 file=$2 value
  # /proc/<pid>/io uses `field: value`; parsing by whitespace silently
  # returned zero for every counter when the colon was left attached.
  value="$(awk -F: -v key="$field" '$1 == key {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; found=1; exit} END {if (!found) print 0}' "$file" 2>/dev/null || echo 0)"
  [[ "$value" =~ ^[0-9]+$ ]] && echo "$value" || echo 0
}

read_stat() {
  local sample_pid=$1
  local file="/proc/$sample_pid/stat" line rest utime stime rss starttime
  [[ -r "$file" ]] || return 1
  line="$(<"$file")"
  rest="${line##*) }"
  [[ "$rest" != "$line" ]] || return 1
  local -a fields=()
  read -r -a fields <<< "$rest" || return 1
  utime=${fields[11]:-}
  stime=${fields[12]:-}
  rss=${fields[21]:-}
  starttime=${fields[19]:-}
  [[ "$utime" =~ ^[0-9]+$ && "$stime" =~ ^[0-9]+$ && "$rss" =~ ^-?[0-9]+$ && "$starttime" =~ ^[0-9]+$ ]] || return 1
  echo "$utime $stime $rss $starttime"
}

declare -A prev_read=() prev_write=() prev_rchar=() prev_wchar=() prev_cpu=() prev_start=()
first_sample=1
total_read_delta=0
total_write_delta=0
total_rchar_delta=0
total_wchar_delta=0
total_cpu_delta=0
previous_time="$(date +%s.%N)"
sample_index=0
owned_natural_exit=0
owned_exit_code=0
while :; do
  pids=()
  while read -r item; do [[ -n "$item" ]] && pids+=("$item"); done < <(pid_set | sort -n -u)
  if ((${#pids[@]} == 0)); then
    if [[ "$start_owned" == 0 ]]; then
      echo "monitor-process-io: observed PID $pid exited or became unreadable" >&2
    fi
    break
  fi

  read_bytes=0; write_bytes=0; rchar=0; wchar=0; rss_bytes=0; cpu_total=0
  read_delta=0; write_delta=0; rchar_delta=0; wchar_delta=0; cpu_delta=0; live_pids=()
  identity_changed=0
  for sample_pid in "${pids[@]}"; do
    [[ -d "/proc/$sample_pid" ]] || continue
    current_read=$(read_counter read_bytes "/proc/$sample_pid/io")
    current_write=$(read_counter write_bytes "/proc/$sample_pid/io")
    current_rchar=$(read_counter rchar "/proc/$sample_pid/io")
    current_wchar=$(read_counter wchar "/proc/$sample_pid/io")
    read_bytes=$((read_bytes + current_read))
    write_bytes=$((write_bytes + current_write))
    rchar=$((rchar + current_rchar))
    wchar=$((wchar + current_wchar))
    if stat_values=$(read_stat "$sample_pid"); then
      read -r user_ticks sys_ticks rss_pages starttime <<< "$stat_values"
      if [[ "$start_owned" == 0 && "$sample_pid" == "$pid" && "$starttime" != "$external_starttime" ]]; then
        echo "monitor-process-io: PID $pid identity changed (starttime $external_starttime -> $starttime); stopping" >&2
        identity_changed=1
        break
      fi
      cpu_total=$((cpu_total + user_ticks + sys_ticks))
      rss_bytes=$((rss_bytes + rss_pages * page_size))
      live_pids+=("$sample_pid")

      # Track counters per PID and process start time. A child that exits is
      # simply absent from the next sample; its previous counters never get
      # subtracted from the aggregate. PID reuse resets the baseline.
      if [[ "${prev_start[$sample_pid]:-}" == "$starttime" ]]; then
        [[ "$current_read" -ge "${prev_read[$sample_pid]}" ]] && read_delta=$((read_delta + current_read - prev_read[$sample_pid]))
        [[ "$current_write" -ge "${prev_write[$sample_pid]}" ]] && write_delta=$((write_delta + current_write - prev_write[$sample_pid]))
        [[ "$current_rchar" -ge "${prev_rchar[$sample_pid]}" ]] && rchar_delta=$((rchar_delta + current_rchar - prev_rchar[$sample_pid]))
        [[ "$current_wchar" -ge "${prev_wchar[$sample_pid]}" ]] && wchar_delta=$((wchar_delta + current_wchar - prev_wchar[$sample_pid]))
        current_cpu=$((user_ticks + sys_ticks))
        [[ "$current_cpu" -ge "${prev_cpu[$sample_pid]}" ]] && cpu_delta=$((cpu_delta + current_cpu - prev_cpu[$sample_pid]))
      elif [[ "$first_sample" == 0 || "$start_owned" == 1 ]]; then
        read_delta=$((read_delta + current_read))
        write_delta=$((write_delta + current_write))
        rchar_delta=$((rchar_delta + current_rchar))
        wchar_delta=$((wchar_delta + current_wchar))
        cpu_delta=$((cpu_delta + user_ticks + sys_ticks))
      fi
      prev_start[$sample_pid]=$starttime
      prev_read[$sample_pid]=$current_read
      prev_write[$sample_pid]=$current_write
      prev_rchar[$sample_pid]=$current_rchar
      prev_wchar[$sample_pid]=$current_wchar
      prev_cpu[$sample_pid]=$((user_ticks + sys_ticks))
    fi
  done
  ((identity_changed == 0)) || break
  if ((${#live_pids[@]} == 0)); then
    if [[ "$start_owned" == 1 ]]; then
      if wait "$pid"; then owned_exit_code=0; else owned_exit_code=$?; fi
      owned_natural_exit=1
    fi
    break
  fi

  now="$(date +%s.%N)"
  elapsed="$(awk -v a="$previous_time" -v b="$now" 'BEGIN {print b-a}')"
  cpu_percent="$(awk -v d="$cpu_delta" -v hz="$clock_tick" -v e="$elapsed" 'BEGIN {if (e<=0) print "0.00"; else printf "%.2f", d/(hz*e)*100}')"
  total_read_delta=$((total_read_delta + read_delta))
  total_write_delta=$((total_write_delta + write_delta))
  total_rchar_delta=$((total_rchar_delta + rchar_delta))
  total_wchar_delta=$((total_wchar_delta + wchar_delta))
  total_cpu_delta=$((total_cpu_delta + cpu_delta))
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$now" "$pid" "$(IFS=,; echo "${live_pids[*]}")" "$read_bytes" "$write_bytes" "$rchar" "$wchar" "$rss_bytes" \
    "$read_delta" "$write_delta" "$rchar_delta" "$wchar_delta" "$cpu_delta" "$total_cpu_delta" "$cpu_percent" >> "$log_file"

  if [[ "$first_sample" == 0 || "$start_owned" == 1 ]]; then
    warn=0
    [[ -n "$read_threshold" && "$read_delta" -ge "$read_threshold" ]] && warn=1
    [[ -n "$write_threshold" && "$write_delta" -ge "$write_threshold" ]] && warn=1
    [[ -n "$rchar_threshold" && "$rchar_delta" -ge "$rchar_threshold" ]] && warn=1
    [[ -n "$wchar_threshold" && "$wchar_delta" -ge "$wchar_threshold" ]] && warn=1
    [[ -n "$cpu_threshold" && "$cpu_delta" -ge "$cpu_threshold" ]] && warn=1
    [[ -n "$rss_threshold" && "$rss_bytes" -ge "$rss_threshold" ]] && warn=1
    if ((warn)); then
      printf 'monitor-process-io WARNING pid=%s read_delta=%s write_delta=%s rchar_delta=%s wchar_delta=%s cpu_jiffies_delta=%s rss_bytes=%s\n' \
        "$pid" "$read_delta" "$write_delta" "$rchar_delta" "$wchar_delta" "$cpu_delta" "$rss_bytes" >&2
    fi
  fi
  first_sample=0
  previous_time=$now
  sample_index=$((sample_index + 1))
  [[ -n "$samples" && "$sample_index" -ge "$samples" ]] && break
  sleep "$interval"
done

if [[ "$start_owned" == 1 && "$owned_natural_exit" == 0 ]]; then
  # A sample limit is a monitor decision, not the owned command's exit code.
  # Cleanup remains restricted to the verified process group.
  cleanup_owned
  owned_pgid=''
fi
if [[ "$start_owned" == 1 && "$owned_natural_exit" == 1 ]]; then
  exit "$owned_exit_code"
fi
