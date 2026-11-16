// SPDX-License-Identifier: Apache-2.0
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

// Test actor only; never shipped or loaded by the runtime.
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  const char *mode = argv[1];
  struct timespec start, end; clock_gettime(CLOCK_MONOTONIC, &start);
  int fd = open(argv[2], O_RDWR | (strstr(mode, "nonblock") ? O_NONBLOCK : 0));
  if (fd < 0) { printf("{\"opened\":false,\"errno\":%d}\n", errno); return 0; }
  struct stat st; if (fstat(fd, &st) != 0) return 3;
  char *mapping = NULL;
  if (strstr(mode, "map")) {
    mapping = mmap(NULL, st.st_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (mapping == MAP_FAILED) return 4;
    mapping[0] = mapping[0];
    close(fd); fd = -1;
  }
  if (strstr(mode, "fork")) {
    pid_t child = fork();
    if (child < 0) return 5;
    if (child > 0) { int status; waitpid(child, &status, 0); return WIFEXITED(status) ? WEXITSTATUS(status) : 6; }
  }
  if (strstr(mode, "hold")) {
    printf("{\"ready\":true,\"pid\":%d,\"mapped\":%s,\"fdClosed\":%s}\n", getpid(), mapping ? "true" : "false", fd < 0 ? "true" : "false"); fflush(stdout);
    char command[32];
    while (fgets(command, sizeof(command), stdin)) {
      if (!strncmp(command, "stop", 4)) break;
      if (!strncmp(command, "mutate", 6)) {
        if (mapping) mapping[0] ^= 1;
        else { char byte; if (pread(fd, &byte, 1, 0) != 1) return 7; byte ^= 1; if (pwrite(fd, &byte, 1, 0) != 1) return 8; }
        puts("{\"mutated\":true}"); fflush(stdout);
      }
    }
  } else {
    if (mapping) { mapping[0] ^= 1; msync(mapping, st.st_size, MS_SYNC); }
    else if (!strstr(mode, "nonblock")) { char byte; if (pread(fd, &byte, 1, 0) != 1) return 7; byte ^= 1; if (pwrite(fd, &byte, 1, 0) != 1) return 8; }
    clock_gettime(CLOCK_MONOTONIC, &end);
    double ms = (end.tv_sec - start.tv_sec) * 1000.0 + (end.tv_nsec - start.tv_nsec) / 1000000.0;
    printf("{\"opened\":true,\"elapsedMs\":%.6f,\"pid\":%d}\n", ms, getpid());
  }
  if (mapping) munmap(mapping, st.st_size);
  if (fd >= 0) close(fd);
  return 0;
}
