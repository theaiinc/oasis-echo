#import "ObjCExceptionCatcher.h"

@implementation OEExceptionCatcher

+ (BOOL)catchException:(NS_NOESCAPE void (^)(void))block error:(NSError * _Nullable * _Nullable)error {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (error) {
            NSString *reason = exception.reason ?: exception.name;
            *error = [NSError errorWithDomain:@"ObjCException"
                                         code:1
                                     userInfo:@{
                NSLocalizedDescriptionKey: reason,
                @"ExceptionName": exception.name,
            }];
        }
        return NO;
    }
}

@end
