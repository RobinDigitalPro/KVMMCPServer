#ifndef OPEN_DESKTOP_HID_CONTRACT_H
#define OPEN_DESKTOP_HID_CONTRACT_H

/* Portable validation: also compiled by the small user-mode C test. */
static int OdhValidateReport(const unsigned char* r, unsigned long n)
{
    unsigned long i, j;
    if (!r || !n) return 0;
    if (r[0] == 4 && n == 5)
        return r[1] <= 7 && r[2] != 128 && r[3] != 128 && r[4] != 128;
    if (r[0] == 3 && n == 7)
        return r[1] <= 7 && r[3] <= 127 && r[5] <= 127 && r[6] != 128;
    if (r[0] != 7 || n != 9 || r[2] != 0) return 0;
    for (i = 3; i < 9; i++) {
        if (!r[i]) continue;
        if (r[i] < 4 || r[i] > 0x65) return 0;
        for (j = 3; j < i; j++) if (r[j] == r[i]) return 0;
    }
    return 1;
}

#endif
