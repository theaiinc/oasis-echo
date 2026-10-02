#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Swift cannot catch NSException; one that unwinds through Swift frames
/// leaves the process in an undefined state (e.g. a wedged main actor).
@interface OEExceptionCatcher : NSObject
/// Runs `block`, converting any Objective-C exception it raises into an
/// NSError. Imported into Swift as `try OEExceptionCatcher.catchException { … }`.
+ (BOOL)catchException:(NS_NOESCAPE void (^)(void))block error:(NSError * _Nullable * _Nullable)error;
@end

NS_ASSUME_NONNULL_END
