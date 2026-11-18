#include <stdio.h>
#include "../driver/report_contract.h"

int main(void)
{
    unsigned char relative[] = {4, 5, 129, 127, 255};
    unsigned char absolute[] = {3, 1, 255, 127, 0, 0, 1};
    unsigned char keyboard[] = {7, 2, 0, 4, 40, 0, 0, 0, 0};
    unsigned long length;
    int checks = 0;
    if (!OdhValidateReport(relative, sizeof(relative))) return 1; checks++;
    if (!OdhValidateReport(absolute, sizeof(absolute))) return 2; checks++;
    if (!OdhValidateReport(keyboard, sizeof(keyboard))) return 3; checks++;
    for (length = 0; length < sizeof(relative); length++) {
        if (OdhValidateReport(relative, length)) return 4; checks++;
    }
    relative[2] = 128;
    if (OdhValidateReport(relative, sizeof(relative))) return 5; checks++;
    absolute[3] = 128;
    if (OdhValidateReport(absolute, sizeof(absolute))) return 6; checks++;
    keyboard[4] = 4;
    if (OdhValidateReport(keyboard, sizeof(keyboard))) return 7; checks++;
    if (OdhValidateReport(NULL, 9)) return 8; checks++;
    printf("{\"ok\":true,\"checks\":%d,\"inputSent\":false}\n", checks);
    return 0;
}
