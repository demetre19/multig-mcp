#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define SERVICE_NAME "multig-mcp.v1"

enum {
    EXIT_OK = 0,
    EXIT_USAGE = 2,
    EXIT_INVALID_RECORD = 3,
    EXIT_INPUT = 4,
    EXIT_DUPLICATE = 10,
    EXIT_NOT_FOUND = 11,
    EXIT_KEYCHAIN = 12,
    EXIT_OUTPUT = 13
};

static int fail_with(int exit_code, const char *diagnostic) {
    (void)write(STDERR_FILENO, diagnostic, strlen(diagnostic));
    return exit_code;
}

static bool alias_character(unsigned char character) {
    return (character >= 'a' && character <= 'z') ||
           (character >= 'A' && character <= 'Z') ||
           (character >= '0' && character <= '9') ||
           character == '.' || character == '_' || character == '-';
}

static bool valid_record_name(const char *record) {
    if (strcmp(record, "oauth-client") == 0) {
        return true;
    }
    if (strncmp(record, "gmail:", 6) != 0 || record[6] == '\0') {
        return false;
    }
    size_t length = strlen(record + 6);
    if (length > 64) {
        return false;
    }
    for (size_t index = 6; record[index] != '\0'; index += 1) {
        if (!alias_character((unsigned char)record[index])) {
            return false;
        }
    }
    return true;
}

static CFMutableDictionaryRef query_for(const char *record) {
    CFStringRef account = CFStringCreateWithCString(kCFAllocatorDefault, record, kCFStringEncodingUTF8);
    if (account == NULL) {
        return NULL;
    }
    CFMutableDictionaryRef query = CFDictionaryCreateMutable(
        kCFAllocatorDefault,
        0,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);
    if (query == NULL) {
        CFRelease(account);
        return NULL;
    }
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, CFSTR(SERVICE_NAME));
    CFDictionarySetValue(query, kSecAttrAccount, account);
    CFRelease(account);
    return query;
}

static int read_secret_input(uint8_t **result, size_t *result_length) {
    size_t capacity = 4096;
    size_t length = 0;
    uint8_t *buffer = malloc(capacity);
    if (buffer == NULL) {
        return EXIT_INPUT;
    }
    for (;;) {
        if (length == capacity) {
            if (capacity > SIZE_MAX / 2) {
                free(buffer);
                return EXIT_INPUT;
            }
            size_t next_capacity = capacity * 2;
            uint8_t *next = realloc(buffer, next_capacity);
            if (next == NULL) {
                free(buffer);
                return EXIT_INPUT;
            }
            buffer = next;
            capacity = next_capacity;
        }
        ssize_t count = read(STDIN_FILENO, buffer + length, capacity - length);
        if (count < 0) {
            if (errno == EINTR) {
                continue;
            }
            free(buffer);
            return EXIT_INPUT;
        }
        if (count == 0) {
            break;
        }
        length += (size_t)count;
    }
    if (length == 0) {
        free(buffer);
        return EXIT_INPUT;
    }
    *result = buffer;
    *result_length = length;
    return EXIT_OK;
}

static int map_add_status(OSStatus status) {
    if (status == errSecDuplicateItem) {
        return fail_with(EXIT_DUPLICATE, "duplicate-record\n");
    }
    if (status != errSecSuccess) {
        return fail_with(EXIT_KEYCHAIN, "keychain-error\n");
    }
    return EXIT_OK;
}

static int map_existing_status(OSStatus status) {
    if (status == errSecItemNotFound) {
        return fail_with(EXIT_NOT_FOUND, "record-not-found\n");
    }
    if (status != errSecSuccess) {
        return fail_with(EXIT_KEYCHAIN, "keychain-error\n");
    }
    return EXIT_OK;
}

static int create_record(const char *record, const uint8_t *bytes, size_t length) {
    CFMutableDictionaryRef query = query_for(record);
    if (query == NULL) {
        return fail_with(EXIT_KEYCHAIN, "keychain-error\n");
    }
    CFDataRef data = CFDataCreate(kCFAllocatorDefault, bytes, (CFIndex)length);
    if (data == NULL) {
        CFRelease(query);
        return fail_with(EXIT_INPUT, "secret-input-failed\n");
    }
    CFDictionarySetValue(query, kSecValueData, data);
    OSStatus status = SecItemAdd(query, NULL);
    CFRelease(data);
    CFRelease(query);
    return map_add_status(status);
}

static int replace_record(const char *record, const uint8_t *bytes, size_t length) {
    CFMutableDictionaryRef query = query_for(record);
    if (query == NULL) {
        return fail_with(EXIT_KEYCHAIN, "keychain-error\n");
    }
    CFDataRef data = CFDataCreate(kCFAllocatorDefault, bytes, (CFIndex)length);
    if (data == NULL) {
        CFRelease(query);
        return fail_with(EXIT_INPUT, "secret-input-failed\n");
    }
    CFMutableDictionaryRef attributes = CFDictionaryCreateMutable(
        kCFAllocatorDefault,
        1,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);
    if (attributes == NULL) {
        CFRelease(data);
        CFRelease(query);
        return fail_with(EXIT_KEYCHAIN, "keychain-error\n");
    }
    CFDictionarySetValue(attributes, kSecValueData, data);
    OSStatus status = SecItemUpdate(query, attributes);
    CFRelease(attributes);
    CFRelease(data);
    CFRelease(query);
    return map_existing_status(status);
}

static int write_fd3(const UInt8 *bytes, CFIndex length) {
    CFIndex offset = 0;
    while (offset < length) {
        ssize_t count = write(3, bytes + offset, (size_t)(length - offset));
        if (count < 0) {
            if (errno == EINTR) {
                continue;
            }
            return fail_with(EXIT_OUTPUT, "output-error\n");
        }
        if (count == 0) {
            return fail_with(EXIT_OUTPUT, "output-error\n");
        }
        offset += (CFIndex)count;
    }
    return EXIT_OK;
}

static int read_record(const char *record) {
    CFMutableDictionaryRef query = query_for(record);
    if (query == NULL) {
        return fail_with(EXIT_KEYCHAIN, "keychain-error\n");
    }
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching(query, &result);
    CFRelease(query);
    if (status == errSecItemNotFound) {
        return fail_with(EXIT_NOT_FOUND, "record-not-found\n");
    }
    if (status != errSecSuccess || result == NULL || CFGetTypeID(result) != CFDataGetTypeID()) {
        if (result != NULL) {
            CFRelease(result);
        }
        return fail_with(EXIT_KEYCHAIN, "keychain-error\n");
    }
    int output_status = write_fd3(CFDataGetBytePtr((CFDataRef)result), CFDataGetLength((CFDataRef)result));
    CFRelease(result);
    return output_status;
}

static int delete_record(const char *record) {
    CFMutableDictionaryRef query = query_for(record);
    if (query == NULL) {
        return fail_with(EXIT_KEYCHAIN, "keychain-error\n");
    }
    OSStatus status = SecItemDelete(query);
    CFRelease(query);
    return map_existing_status(status);
}

int main(int argc, char **argv) {
    if (argc != 3) {
        return fail_with(EXIT_USAGE, "invalid-arguments\n");
    }
    const char *operation = argv[1];
    const char *record = argv[2];
    if (!valid_record_name(record)) {
        return fail_with(EXIT_INVALID_RECORD, "invalid-record\n");
    }
    if (strcmp(operation, "read") == 0) {
        return read_record(record);
    }
    if (strcmp(operation, "delete") == 0) {
        return delete_record(record);
    }
    if (strcmp(operation, "create") != 0 && strcmp(operation, "replace") != 0) {
        return fail_with(EXIT_USAGE, "invalid-arguments\n");
    }

    uint8_t *bytes = NULL;
    size_t length = 0;
    int input_status = read_secret_input(&bytes, &length);
    if (input_status != EXIT_OK) {
        return fail_with(input_status, "secret-input-failed\n");
    }
    int result = strcmp(operation, "create") == 0
        ? create_record(record, bytes, length)
        : replace_record(record, bytes, length);
    free(bytes);
    return result;
}
