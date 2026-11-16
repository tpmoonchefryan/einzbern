// SPDX-License-Identifier: Apache-2.0
#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <unistd.h>

// Loaded only by the dedicated, single-main-thread attestor, never a CLI or a
// Worker. No JS callbacks, allocation, locks or logging in a signal handler.
// fcntl is POSIX async-signal-safe. Revocation is stored BEFORE unlocking.
typedef struct {
  volatile sig_atomic_t fd;
  volatile sig_atomic_t valid;
  unsigned incarnation;
  char *path;
  struct statx identity;
} entry;
static entry *entries;
static unsigned capacity, serial;
static pid_t owner;
static int lease_signal;
static volatile sig_atomic_t generation = 1;
static volatile sig_atomic_t exhausted;
static sigset_t lease_signals;
static struct sigaction old_rt, old_io;
typedef struct guard guard;
static int hold_inode(guard *g, unsigned id);

static void advance(void) {
  if (generation == INT_MAX) exhausted = 1;
  else generation++;
}
static void invalidate_lease(entry *e) {
  e->valid = 0;
  advance();
  if (e->fd >= 0) (void)fcntl(e->fd, F_SETLEASE, F_UNLCK);
}
static void on_break(int sig, siginfo_t *info, void *context) {
  (void)context;
  int saved = errno;
  for (unsigned i = 0; i < capacity; i++) {
    // SIGIO is Linux's fallback if the queued signal cannot be delivered.
    if (entries[i].fd >= 0 && (sig == SIGIO || info->si_fd == entries[i].fd))
      invalidate_lease(&entries[i]);
  }
  errno = saved;
}
static void block(sigset_t *prior) { sigprocmask(SIG_BLOCK, &lease_signals, prior); }
static void unblock(sigset_t *prior) { sigprocmask(SIG_SETMASK, prior, NULL); }
static int current_owner(void) { return owner == getpid() && (pid_t)syscall(SYS_gettid) == owner; }
static napi_value fail(napi_env env, const char *message) {
  char text[256];
  snprintf(text, sizeof(text), "%s: %s", message, strerror(errno));
  napi_throw_error(env, "SOURCE_LEASE_UNAVAILABLE", text);
  return NULL;
}
static napi_value integer(napi_env env, int64_t n) { napi_value v; napi_create_int64(env, n, &v); return v; }
static napi_value boolean(napi_env env, int n) { napi_value v; napi_get_boolean(env, n, &v); return v; }
static void prop(napi_env env, napi_value obj, const char *key, napi_value value) { napi_set_named_property(env, obj, key, value); }
static napi_value mount_id(napi_env env, const struct statx *s) {
  char text[32]; napi_value value;
  snprintf(text, sizeof(text), "%llu", (unsigned long long)s->stx_mnt_id);
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
  return value;
}
static char *string_arg(napi_env env, napi_value v) {
  size_t n;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &n) != napi_ok || n == 0 || n >= PATH_MAX) { errno = EINVAL; return NULL; }
  char *s = calloc(n + 1, 1);
  if (s == NULL) return NULL;
  napi_get_value_string_utf8(env, v, s, n + 1, &n);
  if (strlen(s) != n) { free(s); errno = EINVAL; return NULL; }
  return s;
}
static int identity(int fd, struct statx *s) {
  unsigned mask = STATX_BASIC_STATS | STATX_BTIME | STATX_MNT_ID;
  memset(s, 0, sizeof(*s));
  if (statx(fd, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT, mask, s) != 0) return 0;
  if ((s->stx_mask & mask) != mask) { errno = ENOTSUP; return 0; }
  return 1;
}
static int same(const struct statx *a, const struct statx *b) {
  return a->stx_ino == b->stx_ino && a->stx_dev_major == b->stx_dev_major && a->stx_dev_minor == b->stx_dev_minor
    && a->stx_mnt_id == b->stx_mnt_id && a->stx_size == b->stx_size && a->stx_nlink == b->stx_nlink
    && a->stx_mode == b->stx_mode && a->stx_uid == b->stx_uid && a->stx_gid == b->stx_gid
    && a->stx_btime.tv_sec == b->stx_btime.tv_sec && a->stx_btime.tv_nsec == b->stx_btime.tv_nsec
    && a->stx_ctime.tv_sec == b->stx_ctime.tv_sec && a->stx_ctime.tv_nsec == b->stx_ctime.tv_nsec
    && a->stx_mtime.tv_sec == b->stx_mtime.tv_sec && a->stx_mtime.tv_nsec == b->stx_mtime.tv_nsec;
}
// Resolve EVERY component relative to the preceding held directory. A name
// check never follows a symlink (including an ancestor or the library root).
static int named(const char *path, int directory) {
  if (path[0] != '/' || strstr(path, "//") != NULL) { errno = EINVAL; return -1; }
  char copy[PATH_MAX];
  snprintf(copy, sizeof(copy), "%s", path);
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) return -1;
  char *save = NULL, *part = strtok_r(copy + 1, "/", &save);
  while (part != NULL) {
    char *next = strtok_r(NULL, "/", &save);
    if (!strcmp(part, ".") || !strcmp(part, "..")) { close(fd); errno = EINVAL; return -1; }
    int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
    if (next != NULL || directory) flags |= O_DIRECTORY;
    int child = openat(fd, part, flags);
    int saved = errno;
    close(fd);
    if (child < 0) { errno = saved; return -1; }
    fd = child;
    part = next;
  }
  return fd;
}
static int valid(entry *e) {
  if (!current_owner() || exhausted || !e->valid || e->fd < 0) return 0;
  if (fcntl(e->fd, F_GETLEASE) != F_RDLCK) { invalidate_lease(e); return 0; }
  struct statx held, current;
  int fd = named(e->path, 0);
  int ok = fd >= 0 && identity(fd, &current) && identity(e->fd, &held)
    && S_ISREG(held.stx_mode) && held.stx_nlink == 1 && same(&held, &e->identity) && same(&held, &current);
  if (fd >= 0) close(fd);
  if (!ok) invalidate_lease(e);
  return ok && e->valid && fcntl(e->fd, F_GETLEASE) == F_RDLCK;
}
static void close_entry(entry *e) {
  sigset_t prior; block(&prior);
  if (e->fd >= 0) { invalidate_lease(e); close(e->fd); e->fd = -1; }
  free(e->path); e->path = NULL;
  unblock(&prior);
}
static void cleanup(void *unused) {
  (void)unused;
  if (entries == NULL) return;
  for (unsigned i = 0; i < capacity; i++) close_entry(&entries[i]);
  // Keep storage/handlers until process exit: an already queued signal may
  // still arrive. This module belongs to a disposable dedicated process.
}
static napi_value init(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; uint32_t requested;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (entries != NULL || argc != 1 || napi_get_value_uint32(env, argv[0], &requested) != napi_ok || requested < 1 || requested > 8192) { errno = EINVAL; return fail(env, "lease capacity"); }
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) != 0) return fail(env, "fd budget");
  if (limit.rlim_cur < 64) { errno = EMFILE; return fail(env, "fd budget"); }
  capacity = requested;
  if (capacity > (limit.rlim_cur - 32) / 2) capacity = (unsigned)((limit.rlim_cur - 32) / 2);
  entries = calloc(capacity, sizeof(*entries));
  if (entries == NULL) return fail(env, "lease allocation");
  for (unsigned i = 0; i < capacity; i++) entries[i].fd = -1;
  owner = getpid(); lease_signal = SIGRTMIN + 4;
  sigemptyset(&lease_signals); sigaddset(&lease_signals, lease_signal); sigaddset(&lease_signals, SIGIO);
  struct sigaction action = {0};
  action.sa_sigaction = on_break; action.sa_flags = SA_SIGINFO | SA_RESTART; action.sa_mask = lease_signals;
  if (sigaction(lease_signal, NULL, &old_rt) != 0 || sigaction(SIGIO, NULL, &old_io) != 0) return fail(env, "lease signal query");
  if ((old_rt.sa_handler != SIG_DFL && old_rt.sa_handler != SIG_IGN) || (old_io.sa_handler != SIG_DFL && old_io.sa_handler != SIG_IGN)) { errno = EBUSY; return fail(env, "lease signal already owned"); }
  if (sigaction(lease_signal, &action, &old_rt) != 0 || sigaction(SIGIO, &action, &old_io) != 0) return fail(env, "lease signal");
  napi_add_env_cleanup_hook(env, cleanup, NULL);
  napi_value result; napi_create_object(env, &result);
  prop(env, result, "capacity", integer(env, capacity));
  prop(env, result, "signal", integer(env, lease_signal));
  return result;
}
static napi_value acquire_path(napi_env env, napi_value value, guard *g) {
  if (!current_owner() || exhausted || entries == NULL) { errno = EINVAL; return fail(env, "lease owner"); }
  char *path = string_arg(env, value);
  if (path == NULL) return fail(env, "lease path");
  unsigned i;
  for (i = 0; i < capacity && entries[i].fd >= 0; i++);
  if (i == capacity || serial == UINT_MAX) { free(path); errno = EMFILE; return fail(env, "lease capacity"); }
  int fd = named(path, 0);
  struct statx sx; struct statfs fs;
  // Only local ext4 is admitted in this candidate. Successful F_SETLEASE on
  // an unreviewed provider is not a cross-platform capability declaration.
  if (fd < 0 || !identity(fd, &sx) || !S_ISREG(sx.stx_mode) || sx.stx_nlink != 1 || sx.stx_uid != getuid() || fstatfs(fd, &fs) != 0 || fs.f_type != 0xef53) {
    int saved = errno ? errno : ENOTSUP; if (fd >= 0) close(fd); free(path); errno = saved; return fail(env, "lease object/filesystem");
  }
  sigset_t prior; block(&prior);
  entry *e = &entries[i];
  e->path = path; e->identity = sx; e->incarnation = ++serial; e->valid = 1; e->fd = fd;
  struct f_owner_ex own = { .type = F_OWNER_TID, .pid = owner };
  int ok = fcntl(fd, F_SETOWN_EX, &own) == 0 && fcntl(fd, F_SETSIG, lease_signal) == 0 && fcntl(fd, F_SETLEASE, F_RDLCK) == 0;
  // The Crest inode watch precedes the final full held/current-name admission.
  // No attribute-watch gap is left between that admission and the initial SHA.
  if (ok && g != NULL) ok = hold_inode(g, i);
  int saved = errno;
  if (!ok) e->valid = 0;
  unblock(&prior);
  if (!ok || !valid(e)) { close_entry(e); errno = saved; return fail(env, "read lease"); }
  napi_value result; napi_create_object(env, &result);
  prop(env, result, "id", integer(env, i)); prop(env, result, "fd", integer(env, fd));
  prop(env, result, "incarnation", integer(env, e->incarnation));
  prop(env, result, "generation", integer(env, generation));
  prop(env, result, "mountId", mount_id(env, &e->identity));
  return result;
}
static napi_value acquire(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 1) { errno = EINVAL; return fail(env, "lease argument"); }
  return acquire_path(env, argv[0], NULL);
}
static napi_value acquire_crest(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; guard *g = NULL;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 2 || napi_get_value_external(env, argv[1], (void **)&g) != napi_ok || g == NULL) { errno = EINVAL; return fail(env, "Crest guard argument"); }
  return acquire_path(env, argv[0], g);
}
static napi_value check(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; uint32_t n;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 1 || napi_get_array_length(env, argv[0], &n) != napi_ok || n > capacity) return boolean(env, 0);
  sig_atomic_t before = generation;
  int ok = current_owner() && !exhausted;
  for (uint32_t j = 0; j < n; j++) {
    napi_value v; uint32_t id;
    napi_get_element(env, argv[0], j, &v);
    if (napi_get_value_uint32(env, v, &id) != napi_ok || id >= capacity || !valid(&entries[id])) ok = 0;
  }
  return boolean(env, ok && before == generation);
}
static napi_value release(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; uint32_t id;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc == 1 && napi_get_value_uint32(env, argv[0], &id) == napi_ok && id < capacity) close_entry(&entries[id]);
  return boolean(env, 1);
}
static napi_value status(napi_env env, napi_callback_info info) {
  (void)info; unsigned held = 0, live = 0;
  for (unsigned i = 0; i < capacity; i++) { held += entries[i].fd >= 0; live += entries[i].valid != 0; }
  napi_value result; napi_create_object(env, &result);
  prop(env, result, "generation", integer(env, generation)); prop(env, result, "held", integer(env, held));
  prop(env, result, "live", integer(env, live)); prop(env, result, "capacity", integer(env, capacity));
  return result;
}
typedef struct { int wd; char **names; uint32_t count; int all; int lease_id; unsigned incarnation; } watch_rule;
struct guard { int fd; watch_rule *rules; uint32_t count, names_total; };
static void clear_rules(guard *g) {
  for (uint32_t i = 0; i < g->count; i++) {
    for (uint32_t j = 0; j < g->rules[i].count; j++) free(g->rules[i].names[j]);
    free(g->rules[i].names);
  }
  free(g->rules); g->rules = NULL; g->count = 0;
}
static void guard_cleanup(napi_env env, void *data, void *hint) {
  (void)env; (void)hint; guard *g = data;
  if (g->fd >= 0) close(g->fd);
  clear_rules(g);
  free(g);
}
static napi_value watch(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; uint32_t n;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 1 || napi_get_array_length(env, argv[0], &n) != napi_ok || n > 8192) { errno = EINVAL; return fail(env, "watch set"); }
  guard *g = calloc(1, sizeof(*g));
  if (g == NULL) return fail(env, "watch allocation");
  g->fd = inotify_init1(IN_CLOEXEC | IN_NONBLOCK);
  if (g->fd < 0) { free(g); return fail(env, "inotify"); }
  g->rules = calloc(8192, sizeof(*g->rules)); g->count = n;
  if (g->rules == NULL) { g->count = 0; guard_cleanup(env, g, NULL); return fail(env, "watch rules"); }
  uint32_t names_total = 0;
  for (uint32_t i = 0; i < n; i++) {
    napi_value v, name, names; napi_get_element(env, argv[0], i, &v);
    napi_get_named_property(env, v, "path", &name);
    napi_get_named_property(env, v, "names", &names);
    watch_rule *rule = &g->rules[i]; rule->lease_id = -1;
    napi_valuetype type; napi_typeof(env, names, &type);
    rule->all = type == napi_null;
    if (!rule->all) {
      uint32_t count;
      if (napi_get_array_length(env, names, &count) != napi_ok || count > 8192 || (names_total += count) > 65536) { guard_cleanup(env, g, NULL); errno = EINVAL; return fail(env, "watch names"); }
      rule->count = count;
      rule->names = calloc(rule->count, sizeof(char *));
      if (rule->names == NULL) { rule->count = 0; guard_cleanup(env, g, NULL); return fail(env, "watch name allocation"); }
      for (uint32_t j = 0; j < rule->count; j++) {
        napi_value item; napi_get_element(env, names, j, &item); rule->names[j] = string_arg(env, item);
        if (rule->names[j] == NULL || strlen(rule->names[j]) > NAME_MAX || strchr(rule->names[j], '/')) { guard_cleanup(env, g, NULL); errno = EINVAL; return fail(env, "watch child name"); }
      }
    }
    char *path = string_arg(env, name);
    int fd = path == NULL ? -1 : named(path, 1);
    char held[64]; snprintf(held, sizeof(held), "/proc/self/fd/%d", fd);
    int wd = fd < 0 ? -1 : inotify_add_watch(g->fd, held, IN_ONLYDIR | IN_MODIFY | IN_ATTRIB | IN_MOVED_FROM | IN_MOVED_TO | IN_CREATE | IN_DELETE | IN_DELETE_SELF | IN_MOVE_SELF | IN_UNMOUNT);
    rule->wd = wd;
    if (fd >= 0) close(fd);
    free(path);
    if (wd < 0) { guard_cleanup(env, g, NULL); return fail(env, "directory watch"); }
  }
  g->names_total = names_total;
  napi_value result; napi_create_external(env, g, guard_cleanup, NULL, &result); return result;
}
static int drain_guard(guard *g) {
  if (g == NULL || g->fd < 0 || !current_owner()) return 0;
  union { struct inotify_event align; char bytes[65536]; } buffer;
  int ok = 0;
  // Filter ONLY unrelated children of ancestry directories. Enumerated source
  // directories watch every child, so additions/partial sets cannot disappear.
  for (unsigned batch = 0; batch < 128; batch++) {
    ssize_t n = read(g->fd, buffer.bytes, sizeof(buffer.bytes));
    if (n < 0 && errno == EAGAIN) { ok = 1; break; }
    if (n <= 0) break;
    int dirty = 0;
    for (size_t offset = 0; offset < (size_t)n;) {
      struct inotify_event *event = (struct inotify_event *)(buffer.bytes + offset);
      size_t length = sizeof(*event) + event->len;
      if (offset + length > (size_t)n || (event->mask & (IN_Q_OVERFLOW | IN_IGNORED | IN_DELETE_SELF | IN_MOVE_SELF | IN_UNMOUNT)) || event->len == 0) { dirty = 1; break; }
      watch_rule *rule = NULL;
      for (uint32_t i = 0; i < g->count; i++) if (g->rules[i].wd == event->wd) { rule = &g->rules[i]; break; }
      if (rule == NULL || rule->all) { dirty = 1; break; }
      for (uint32_t j = 0; j < rule->count; j++) if (!strcmp(rule->names[j], event->name)) { dirty = 1; break; }
      if (dirty) break;
      offset += length;
    }
    if (dirty) break;
  }
  if (!ok) { close(g->fd); g->fd = -1; clear_rules(g); }
  return ok;
}
static napi_value guard_check(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; guard *g = NULL;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 1 || napi_get_value_external(env, argv[0], (void **)&g) != napi_ok) return boolean(env, 0);
  return boolean(env, drain_guard(g));
}
// Extend before discovering a directory's members. Repeated ancestry rules are
// merged; upgrading to all children never discards a queued event.
static napi_value guard_add(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3]; guard *g = NULL; uint32_t count = 0;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 3 || napi_get_value_external(env, argv[0], (void **)&g) != napi_ok || g == NULL || g->fd < 0 || !current_owner()) { errno = EINVAL; return fail(env, "guard add"); }
  napi_valuetype type; napi_typeof(env, argv[2], &type);
  int all = type == napi_null;
  if (!all && (napi_get_array_length(env, argv[2], &count) != napi_ok || count > 8192 || count > 65536 - g->names_total)) { errno = EINVAL; return fail(env, "guard names"); }
  char *path = string_arg(env, argv[1]);
  int fd = path == NULL ? -1 : named(path, 1);
  free(path);
  struct statx observed;
  int identified = fd >= 0 && identity(fd, &observed);
  char held[64]; snprintf(held, sizeof(held), "/proc/self/fd/%d", fd);
  int wd = !identified ? -1 : inotify_add_watch(g->fd, held, IN_MASK_ADD | IN_ONLYDIR | IN_MODIFY | IN_ATTRIB | IN_MOVED_FROM | IN_MOVED_TO | IN_CREATE | IN_DELETE | IN_DELETE_SELF | IN_MOVE_SELF | IN_UNMOUNT);
  if (fd >= 0) close(fd);
  if (wd < 0) return fail(env, "guard directory");
  watch_rule *rule = NULL;
  for (uint32_t i = 0; i < g->count; i++) if (g->rules[i].wd == wd) rule = &g->rules[i];
  if (rule == NULL) {
    if (g->count == 8192) { errno = ENOSPC; return fail(env, "guard capacity"); }
    rule = &g->rules[g->count++]; rule->wd = wd; rule->lease_id = -1;
  }
  if (rule->lease_id >= 0) { errno = EINVAL; return fail(env, "guard directory alias"); }
  if (all) rule->all = 1;
  if (!rule->all && count > 0) {
    char **names = realloc(rule->names, (rule->count + count) * sizeof(char *));
    if (names == NULL) return fail(env, "guard name allocation");
    rule->names = names;
    for (uint32_t j = 0; j < count; j++) {
      napi_value item; napi_get_element(env, argv[2], j, &item);
      char *name = string_arg(env, item);
      if (name == NULL || strlen(name) > NAME_MAX || strchr(name, '/')) { free(name); errno = EINVAL; return fail(env, "guard child name"); }
      rule->names[rule->count++] = name; g->names_total++;
    }
  }
  return mount_id(env, &observed);
}
// Watch the held inode, including link/attribute changes outside watched source
// directories. This does not prove bytes: writable mappings still need leases.
static int hold_inode(guard *g, unsigned id) {
  if (g == NULL || g->fd < 0 || !current_owner() || id >= capacity || !entries[id].valid || entries[id].fd < 0 || g->count == 8192) { errno = EINVAL; return 0; }
  char held[64]; snprintf(held, sizeof(held), "/proc/self/fd/%d", entries[id].fd);
  int wd = inotify_add_watch(g->fd, held, IN_MASK_ADD | IN_MODIFY | IN_ATTRIB | IN_DELETE_SELF | IN_MOVE_SELF | IN_UNMOUNT);
  if (wd < 0) return 0;
  for (uint32_t i = 0; i < g->count; i++) if (g->rules[i].wd == wd) { errno = EINVAL; return 0; }
  watch_rule *rule = &g->rules[g->count++];
  rule->wd = wd; rule->all = 1; rule->lease_id = (int)id; rule->incarnation = entries[id].incarnation;
  return 1;
}
static napi_value guard_hold(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; guard *g = NULL; uint32_t id;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 2 || napi_get_value_external(env, argv[0], (void **)&g) != napi_ok || napi_get_value_uint32(env, argv[1], &id) != napi_ok || !hold_inode(g, id)) { errno = EINVAL; return fail(env, "guard inode"); }
  return boolean(env, 1);
}
// Only for a complete set admitted under its persistent directory/inode guard.
// No pathname open, stat, statx or enumeration occurs on this warm boundary.
static napi_value guarded_check(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3]; guard *g = NULL; uint32_t n; int32_t expected;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 3 || napi_get_value_external(env, argv[0], (void **)&g) != napi_ok || napi_get_array_length(env, argv[1], &n) != napi_ok
    || napi_get_value_int32(env, argv[2], &expected) != napi_ok || n > capacity || exhausted || generation != expected || !drain_guard(g)) return boolean(env, 0);
  uint32_t covered = 0;
  for (uint32_t j = 0; j < g->count; j++) {
    watch_rule *rule = &g->rules[j];
    if (rule->lease_id < 0) continue;
    if (covered >= n) return boolean(env, 0);
    napi_value v; uint32_t id; napi_get_element(env, argv[1], covered++, &v);
    if (napi_get_value_uint32(env, v, &id) != napi_ok || id >= capacity || id != (uint32_t)rule->lease_id) return boolean(env, 0);
    entry *e = &entries[id];
    if (!e->valid || e->fd < 0 || e->incarnation != rule->incarnation) return boolean(env, 0);
    if (fcntl(e->fd, F_GETLEASE) != F_RDLCK) { invalidate_lease(e); return boolean(env, 0); }
  }
  int ok = covered == n && drain_guard(g) && !exhausted && generation == expected;
  return boolean(env, ok);
}
// Obtain the kernel peer, never a PID supplied in authenticated request text.
static napi_value peer(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; int32_t fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  struct ucred credentials; socklen_t length = sizeof(credentials);
  struct sockaddr address; socklen_t address_length = sizeof(address);
  if (argc != 1 || !current_owner() || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0
    || getsockname(fd, &address, &address_length) != 0 || address.sa_family != AF_UNIX
    || getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0 || length != sizeof(credentials)
    || credentials.pid <= 0 || credentials.uid != getuid()) { errno = EACCES; return fail(env, "private peer"); }
  napi_value result; napi_create_object(env, &result);
  prop(env, result, "pid", integer(env, credentials.pid)); prop(env, result, "uid", integer(env, credentials.uid));
  return result;
}
static napi_value guard_close(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; guard *g = NULL;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc == 1 && napi_get_value_external(env, argv[0], (void **)&g) == napi_ok && g != NULL && g->fd >= 0) { close(g->fd); g->fd = -1; clear_rules(g); }
  return boolean(env, 1);
}
static napi_value module_init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"init", NULL, init, NULL, NULL, NULL, napi_default, NULL},
    {"acquire", NULL, acquire, NULL, NULL, NULL, napi_default, NULL},
    {"acquireCrest", NULL, acquire_crest, NULL, NULL, NULL, napi_default, NULL},
    {"check", NULL, check, NULL, NULL, NULL, napi_default, NULL},
    {"release", NULL, release, NULL, NULL, NULL, napi_default, NULL},
    {"status", NULL, status, NULL, NULL, NULL, napi_default, NULL},
    {"watch", NULL, watch, NULL, NULL, NULL, napi_default, NULL},
    {"guardCheck", NULL, guard_check, NULL, NULL, NULL, napi_default, NULL},
    {"guardClose", NULL, guard_close, NULL, NULL, NULL, napi_default, NULL},
    {"guardAdd", NULL, guard_add, NULL, NULL, NULL, napi_default, NULL},
    {"guardHold", NULL, guard_hold, NULL, NULL, NULL, napi_default, NULL},
    {"guardedCheck", NULL, guarded_check, NULL, NULL, NULL, napi_default, NULL},
    {"peer", NULL, peer, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, module_init)
