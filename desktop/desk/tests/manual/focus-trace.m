#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#include <stdio.h>
#include <time.h>

static double elapsed(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return now.tv_sec + now.tv_nsec / 1e9;
}

static pid_t focused_pid(void) {
    AXUIElementRef system = AXUIElementCreateSystemWide();
    AXUIElementRef app = NULL;
    pid_t pid = 0;
    if (AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute, (CFTypeRef *)&app) == kAXErrorSuccess && app) {
        AXUIElementGetPid(app, &pid);
        CFRelease(app);
    }
    CFRelease(system);
    return pid;
}

static CGEventRef witness(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *context) {
    (void)proxy;
    (void)context;
    if ((uint32_t)type == 21) {
        fprintf(stderr, "%.6f process-notification source=%lld target=%lld subtype=0x%llx subject=%lld theft=%lld foreground=%d\n",
            elapsed(),
            CGEventGetIntegerValueField(event, kCGEventSourceUnixProcessID),
            CGEventGetIntegerValueField(event, kCGEventTargetUnixProcessID),
            (unsigned long long)CGEventGetIntegerValueField(event, (CGEventField)64),
            CGEventGetIntegerValueField(event, (CGEventField)73),
            CGEventGetIntegerValueField(event, (CGEventField)71),
            focused_pid());
    }
    return event;
}

static void order_snapshot(const char *label) {
    CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
    fprintf(stderr, "%.6f %s foreground=%d windows=", elapsed(), label, focused_pid());
    if (windows) {
        CFIndex count = CFArrayGetCount(windows);
        for (CFIndex i = 0; i < count && i < 8; i++) {
            CFDictionaryRef info = CFArrayGetValueAtIndex(windows, i);
            CFNumberRef number = CFDictionaryGetValue(info, kCGWindowNumber);
            int window = 0;
            if (number && CFNumberGetValue(number, kCFNumberIntType, &window)) fprintf(stderr, "%d,", window);
        }
        CFRelease(windows);
    }
    fputc('\n', stderr);
}

int main(void) {
    @autoreleasepool {
        CGEventMask mask = (CGEventMask)1 << 21;
        CFMachPortRef tap = CGEventTapCreate(kCGAnnotatedSessionEventTap, kCGHeadInsertEventTap,
            kCGEventTapOptionListenOnly, mask, witness, NULL);
        if (!tap) {
            fputs("Cannot install listen-only event tap; check Accessibility/Input Monitoring permissions.\n", stderr);
            return 1;
        }
        CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(NULL, tap, 0);
        if (!source) { CFRelease(tap); return 1; }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopDefaultMode);
        order_snapshot("start");
        double end = elapsed() + 20.0;
        while (elapsed() < end) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
        order_snapshot("end");
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, kCFRunLoopDefaultMode);
        CFRelease(source);
        CFRelease(tap);
    }
    return 0;
}
