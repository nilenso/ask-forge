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
 *   ./seccomp-net-block <arch> <output-file>
 *   arch: x64 or arm64
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
    uint32_t arch;

    if (argc != 3) {
        fprintf(stderr, "Usage: %s <arch> <output-file>\n", argv[0]);
        fprintf(stderr, "  arch: x64 or arm64\n");
        return 1;
    }

    const char *arch_str = argv[1];
    const char *output_file = argv[2];

    /* Parse architecture */
    if (strcmp(arch_str, "x64") == 0) {
        arch = SCMP_ARCH_X86_64;
    } else if (strcmp(arch_str, "arm64") == 0) {
        arch = SCMP_ARCH_AARCH64;
    } else {
        fprintf(stderr, "Error: Unknown architecture '%s'. Use 'x64' or 'arm64'.\n", arch_str);
        return 1;
    }

    /* Create seccomp context with default action ALLOW */
    ctx = seccomp_init(SCMP_ACT_ALLOW);
    if (ctx == NULL) {
        fprintf(stderr, "Error: Failed to initialize seccomp context\n");
        return 1;
    }

    /* Remove native arch and add target arch */
    rc = seccomp_arch_remove(ctx, SCMP_ARCH_NATIVE);
    if (rc < 0 && rc != -ENOENT) {
        fprintf(stderr, "Error: Failed to remove native arch: %s\n", strerror(-rc));
        seccomp_release(ctx);
        return 1;
    }

    rc = seccomp_arch_add(ctx, arch);
    if (rc < 0) {
        fprintf(stderr, "Error: Failed to add %s arch: %s\n", arch_str, strerror(-rc));
        seccomp_release(ctx);
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

    printf("Generated %s BPF filter: %s\n", arch_str, output_file);
    return 0;
}
