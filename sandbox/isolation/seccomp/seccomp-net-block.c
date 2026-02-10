/*
 * Seccomp BPF filter generator to block network socket creation
 *
 * This program generates a seccomp-bpf filter that blocks the socket() syscall
 * when called with AF_INET or AF_INET6 as the domain argument. This prevents
 * creation of IPv4 and IPv6 sockets while allowing Unix domain sockets and
 * all other syscalls.
 *
 * Compilation:
 *   gcc -o seccomp-net-block seccomp-net-block.c -lseccomp
 *
 * Usage:
 *   ./seccomp-net-block <output-file>
 *
 * Dependencies:
 *   - libseccomp (libseccomp-dev package on Debian/Ubuntu, libseccomp on Alpine)
 */

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <seccomp.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>

int main(int argc, char *argv[]) {
    scmp_filter_ctx ctx;
    int rc;

    if (argc != 2) {
        fprintf(stderr, "Usage: %s <output-file>\n", argv[0]);
        return 1;
    }

    const char *output_file = argv[1];

    /* Create seccomp context with default action ALLOW */
    ctx = seccomp_init(SCMP_ACT_ALLOW);
    if (ctx == NULL) {
        fprintf(stderr, "Error: Failed to initialize seccomp context\n");
        return 1;
    }

    /* Block socket(AF_INET, ...) - IPv4 */
    rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socket), 1,
                          SCMP_A0(SCMP_CMP_EQ, AF_INET));
    if (rc < 0) {
        fprintf(stderr, "Error: Failed to add AF_INET rule: %s\n", strerror(-rc));
        seccomp_release(ctx);
        return 1;
    }

    /* Block socket(AF_INET6, ...) - IPv6 */
    rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socket), 1,
                          SCMP_A0(SCMP_CMP_EQ, AF_INET6));
    if (rc < 0) {
        fprintf(stderr, "Error: Failed to add AF_INET6 rule: %s\n", strerror(-rc));
        seccomp_release(ctx);
        return 1;
    }

    /* Export the filter to a file */
    int fd = open(output_file, O_CREAT | O_WRONLY | O_TRUNC, 0644);
    if (fd < 0) {
        fprintf(stderr, "Error: Failed to open output file: %s\n", strerror(errno));
        seccomp_release(ctx);
        return 1;
    }

    rc = seccomp_export_bpf(ctx, fd);
    if (rc < 0) {
        fprintf(stderr, "Error: Failed to export seccomp filter: %s\n", strerror(-rc));
        close(fd);
        seccomp_release(ctx);
        return 1;
    }

    close(fd);
    seccomp_release(ctx);

    printf("Generated BPF filter: %s\n", output_file);
    return 0;
}
