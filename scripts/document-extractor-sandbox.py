"""Windows-only resource boundary for the fixed, reviewed local PDF extractor.

This is not a file/network security sandbox. No account or system setting changes.
The parser starts inside a native Job Object, including when the host uses a job.
"""
import ctypes
from ctypes import wintypes as W
import dataclasses
import json
import math
import os
import pathlib
import subprocess
import sys
import threading
import time

MIB = 1024 * 1024
KILL_ON_CLOSE = 0x2000
PROCESS_MEMORY = 0x100
JOB_MEMORY = 0x200
ACTIVE_PROCESS = 0x8
ATTRIBUTE_JOB_LIST = 0x2000D
ATTRIBUTE_HANDLE_LIST = 0x20002
EXTENDED_STARTUP = 0x80000
NO_WINDOW = 0x08000000
UNICODE_ENVIRONMENT = 0x400
BROKEN_PIPE = 109
WAIT_TIMEOUT = 258


@dataclasses.dataclass(frozen=True)
class Limits:
    process_memory_bytes: int = 64 * MIB
    job_memory_bytes: int = 96 * MIB
    processes: int = 2  # Frozen extractor uses a parent and a parser child.
    wall_seconds: float = 20
    input_bytes: int = 512 * 1024
    stdout_bytes: int = MIB
    stderr_bytes: int = 64 * 1024

    def validate(self):
        if (type(self.process_memory_bytes) is not int or not 4 * MIB <= self.process_memory_bytes <= 128 * MIB or
                type(self.job_memory_bytes) is not int or not self.process_memory_bytes <= self.job_memory_bytes <= 128 * MIB or
                type(self.processes) is not int or self.processes not in (1, 2) or
                type(self.wall_seconds) not in (int, float) or not 0.05 <= self.wall_seconds <= 20 or
                type(self.input_bytes) is not int or not 1 <= self.input_bytes <= 512 * 1024 or
                type(self.stdout_bytes) is not int or not 64 <= self.stdout_bytes <= MIB or
                type(self.stderr_bytes) is not int or not 64 <= self.stderr_bytes <= 64 * 1024):
            raise BoundedExecutionError('invalid-limits')


class BoundedExecutionError(Exception):
    def __init__(self, code, execution=None):
        super().__init__(code)
        self.code = code
        self.execution = execution


class SecurityAttributes(ctypes.Structure):
    _fields_ = [('nLength', W.DWORD), ('lpSecurityDescriptor', W.LPVOID), ('bInheritHandle', W.BOOL)]


class BasicLimits(ctypes.Structure):
    _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                ('LimitFlags', W.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t), ('MaximumWorkingSetSize', ctypes.c_size_t),
                ('ActiveProcessLimit', W.DWORD), ('Affinity', ctypes.c_size_t), ('PriorityClass', W.DWORD), ('SchedulingClass', W.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_ = [(key, ctypes.c_ulonglong) for key in ['ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
                                                   'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount']]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [('BasicLimitInformation', BasicLimits), ('IoInfo', IoCounters), ('ProcessMemoryLimit', ctypes.c_size_t),
                ('JobMemoryLimit', ctypes.c_size_t), ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]


class Accounting(ctypes.Structure):
    _fields_ = [(key, ctypes.c_longlong) for key in ['TotalUserTime', 'TotalKernelTime', 'ThisPeriodTotalUserTime', 'ThisPeriodTotalKernelTime']] + [
        (key, W.DWORD) for key in ['TotalPageFaultCount', 'TotalProcesses', 'ActiveProcesses', 'TotalTerminatedProcesses']]


class Startup(ctypes.Structure):
    _fields_ = [('cb', W.DWORD), ('lpReserved', W.LPWSTR), ('lpDesktop', W.LPWSTR), ('lpTitle', W.LPWSTR)] + [
        (key, W.DWORD) for key in ['dwX', 'dwY', 'dwXSize', 'dwYSize', 'dwXCountChars', 'dwYCountChars', 'dwFillAttribute', 'dwFlags']] + [
        ('wShowWindow', W.WORD), ('cbReserved2', W.WORD), ('lpReserved2', ctypes.POINTER(ctypes.c_ubyte)),
        ('hStdInput', W.HANDLE), ('hStdOutput', W.HANDLE), ('hStdError', W.HANDLE)]


class StartupEx(ctypes.Structure):
    _fields_ = [('StartupInfo', Startup), ('lpAttributeList', W.LPVOID)]


class ProcessInformation(ctypes.Structure):
    _fields_ = [('hProcess', W.HANDLE), ('hThread', W.HANDLE), ('dwProcessId', W.DWORD), ('dwThreadId', W.DWORD)]


def kernel():
    if sys.platform != 'win32':
        raise BoundedExecutionError('unsupported-platform')
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    signatures = {
        'CreateJobObjectW': ([W.LPVOID, W.LPCWSTR], W.HANDLE),
        'CloseHandle': ([W.HANDLE], W.BOOL),
        'SetInformationJobObject': ([W.HANDLE, ctypes.c_int, W.LPVOID, W.DWORD], W.BOOL),
        'QueryInformationJobObject': ([W.HANDLE, ctypes.c_int, W.LPVOID, W.DWORD, W.LPVOID], W.BOOL),
        'TerminateJobObject': ([W.HANDLE, W.UINT], W.BOOL),
        'CreatePipe': ([ctypes.POINTER(W.HANDLE), ctypes.POINTER(W.HANDLE), ctypes.POINTER(SecurityAttributes), W.DWORD], W.BOOL),
        'SetHandleInformation': ([W.HANDLE, W.DWORD, W.DWORD], W.BOOL),
        'InitializeProcThreadAttributeList': ([W.LPVOID, W.DWORD, W.DWORD, ctypes.POINTER(ctypes.c_size_t)], W.BOOL),
        'UpdateProcThreadAttribute': ([W.LPVOID, W.DWORD, ctypes.c_size_t, W.LPVOID, ctypes.c_size_t, W.LPVOID, W.LPVOID], W.BOOL),
        'DeleteProcThreadAttributeList': ([W.LPVOID], None),
        'CreateProcessW': ([W.LPCWSTR, W.LPWSTR, W.LPVOID, W.LPVOID, W.BOOL, W.DWORD, W.LPVOID, W.LPCWSTR,
                            ctypes.POINTER(StartupEx), ctypes.POINTER(ProcessInformation)], W.BOOL),
        'WaitForSingleObject': ([W.HANDLE, W.DWORD], W.DWORD),
        'GetExitCodeProcess': ([W.HANDLE, ctypes.POINTER(W.DWORD)], W.BOOL),
        'ReadFile': ([W.HANDLE, W.LPVOID, W.DWORD, ctypes.POINTER(W.DWORD), W.LPVOID], W.BOOL),
        'WriteFile': ([W.HANDLE, W.LPVOID, W.DWORD, ctypes.POINTER(W.DWORD), W.LPVOID], W.BOOL),
        'GetCurrentProcess': ([], W.HANDLE),
        'IsProcessInJob': ([W.HANDLE, W.HANDLE, ctypes.POINTER(W.BOOL)], W.BOOL),
        'GetStdHandle': ([W.DWORD], W.HANDLE),
        'GetFileType': ([W.HANDLE], W.DWORD),
        'PeekNamedPipe': ([W.HANDLE, W.LPVOID, W.DWORD, W.LPVOID, ctypes.POINTER(W.DWORD), W.LPVOID], W.BOOL),
    }
    try:
        for name, (args, result) in signatures.items():
            function = getattr(k, name)
            function.argtypes, function.restype = args, result
    except AttributeError:
        raise BoundedExecutionError('native-api-unavailable') from None
    return k


def checked(value, code):
    if not value:
        raise BoundedExecutionError(code)
    return value


def read_bounded_stdin(limit=512 * 1024, deadline=None):
    """Binary pipes only: poll availability instead of blocking outside the job."""
    if type(limit) is not int or not 1 <= limit <= 512 * 1024:
        raise BoundedExecutionError('input-limit')
    deadline = time.monotonic() + 20 if deadline is None else deadline
    k = kernel()
    handle = k.GetStdHandle(0xFFFFFFF6)
    if k.GetFileType(handle) != 3:  # FILE_TYPE_PIPE; console/file stdin is deliberately outside this wrapper.
        raise BoundedExecutionError('stdin-must-be-binary-pipe')
    chunks, size = [], 0
    while time.monotonic() < deadline:
        available = W.DWORD()
        if not k.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
            if ctypes.get_last_error() == BROKEN_PIPE:
                return b''.join(chunks)
            raise BoundedExecutionError('stdin-unavailable')
        if not available.value:
            time.sleep(0.01)
            continue
        count = min(available.value, 4096, limit + 1 - size)
        buffer, read = ctypes.create_string_buffer(count), W.DWORD()
        checked(k.ReadFile(handle, buffer, count, ctypes.byref(read), None), 'stdin-unavailable')
        if not read.value:
            return b''.join(chunks)
        size += read.value
        if size > limit:
            raise BoundedExecutionError('input-limit')
        chunks.append(buffer.raw[:read.value])
    raise BoundedExecutionError('stdin-deadline')


def run_in_job(command, input_bytes=b'', limits=Limits(), deadline=None):
    """Internal resource primitive; public CLI invokes only the reviewed extractor.

    An arbitrary internal test command is not a reviewed document producer.
    Returned execution accounting is local evidence, not a server attestation.
    """
    limits.validate()
    if (not isinstance(command, (list, tuple)) or not command or len(command) > 12 or
            any(not isinstance(arg, str) or not arg or len(arg) > 16384 or '\0' in arg for arg in command) or
            not pathlib.Path(command[0]).is_absolute()):
        raise BoundedExecutionError('invalid-command')
    if not isinstance(input_bytes, bytes) or len(input_bytes) > limits.input_bytes:
        raise BoundedExecutionError('input-limit')
    if deadline is not None and (type(deadline) not in (int, float) or not math.isfinite(deadline)):
        raise BoundedExecutionError('invalid-deadline')
    k = kernel()
    deadline = min(deadline, time.monotonic() + limits.wall_seconds) if deadline is not None else time.monotonic() + limits.wall_seconds
    if deadline <= time.monotonic():
        raise BoundedExecutionError('wall-deadline')
    handles, threads = [], []
    attributes, attributes_live, job, process = None, False, None, None
    output, errors, violation, pipe_error = [], [], threading.Event(), threading.Event()
    parent_job, execution = W.BOOL(), None

    def close(handle):
        if handle in handles:
            handles.remove(handle)
            k.CloseHandle(handle)

    def pipe():
        read, write = W.HANDLE(), W.HANDLE()
        security = SecurityAttributes(ctypes.sizeof(SecurityAttributes), None, True)
        checked(k.CreatePipe(ctypes.byref(read), ctypes.byref(write), ctypes.byref(security), 0), 'pipe-unavailable')
        handles.extend([read.value, write.value])
        return read.value, write.value

    def reader(handle, maximum, chunks):
        size = 0
        while True:
            buffer, count = ctypes.create_string_buffer(4096), W.DWORD()
            if not k.ReadFile(handle, buffer, 4096, ctypes.byref(count), None):
                if ctypes.get_last_error() != BROKEN_PIPE:
                    pipe_error.set()
                return
            if not count.value:
                return
            size += count.value
            if size > maximum:
                violation.set()
                return
            chunks.append(buffer.raw[:count.value])

    def writer(handle):
        try:
            offset = 0
            while offset < len(input_bytes):
                data, count = input_bytes[offset:offset + 4096], W.DWORD()
                if not k.WriteFile(handle, data, len(data), ctypes.byref(count), None) or not count.value:
                    pipe_error.set()
                    return
                offset += count.value
        finally:
            close(handle)

    try:
        checked(k.IsProcessInJob(k.GetCurrentProcess(), None, ctypes.byref(parent_job)), 'host-job-query-failed')
        job = checked(k.CreateJobObjectW(None, None), 'job-unavailable')
        handles.append(job)
        setting = ExtendedLimits()
        setting.BasicLimitInformation.LimitFlags = PROCESS_MEMORY | JOB_MEMORY | ACTIVE_PROCESS | KILL_ON_CLOSE
        setting.BasicLimitInformation.ActiveProcessLimit = limits.processes
        setting.ProcessMemoryLimit, setting.JobMemoryLimit = limits.process_memory_bytes, limits.job_memory_bytes
        checked(k.SetInformationJobObject(job, 9, ctypes.byref(setting), ctypes.sizeof(setting)), 'job-limits-rejected')
        verified = ExtendedLimits()
        checked(k.QueryInformationJobObject(job, 9, ctypes.byref(verified), ctypes.sizeof(verified), None), 'job-limits-unverified')
        if (verified.BasicLimitInformation.LimitFlags != setting.BasicLimitInformation.LimitFlags or
                verified.BasicLimitInformation.ActiveProcessLimit != limits.processes or
                verified.ProcessMemoryLimit != limits.process_memory_bytes or verified.JobMemoryLimit != limits.job_memory_bytes):
            raise BoundedExecutionError('job-limits-unverified')
        stdin_read, stdin_write = pipe()
        stdout_read, stdout_write = pipe()
        stderr_read, stderr_write = pipe()
        for handle in [stdin_write, stdout_read, stderr_read]:
            checked(k.SetHandleInformation(handle, 1, 0), 'handle-policy-rejected')
        size = ctypes.c_size_t()
        k.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
        if not size.value or size.value > 65536:
            raise BoundedExecutionError('job-list-unavailable')
        attributes = ctypes.create_string_buffer(size.value)
        checked(k.InitializeProcThreadAttributeList(attributes, 2, 0, ctypes.byref(size)), 'job-list-unavailable')
        attributes_live = True
        jobs, inherited = (W.HANDLE * 1)(job), (W.HANDLE * 3)(stdin_read, stdout_write, stderr_write)
        checked(k.UpdateProcThreadAttribute(attributes, 0, ATTRIBUTE_JOB_LIST, jobs, ctypes.sizeof(jobs), None, None), 'job-list-rejected')
        checked(k.UpdateProcThreadAttribute(attributes, 0, ATTRIBUTE_HANDLE_LIST, inherited, ctypes.sizeof(inherited), None, None), 'handle-list-rejected')
        startup, process = StartupEx(), ProcessInformation()
        startup.StartupInfo.cb, startup.StartupInfo.dwFlags = ctypes.sizeof(StartupEx), 0x100
        startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError = stdin_read, stdout_write, stderr_write
        startup.lpAttributeList = ctypes.cast(attributes, W.LPVOID)
        # Isolated interpreter and child use the bundled pypdf 6.10.0.
        # No user-site paths, provider tokens or general environment secrets.
        minimal_env = {key: os.environ[key] for key in ['SystemRoot', 'WINDIR'] if key in os.environ}
        minimal_env.update({'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1'})
        environment = ctypes.create_unicode_buffer('\0'.join(f'{key}={value}' for key, value in sorted(minimal_env.items())) + '\0\0')
        command_line = ctypes.create_unicode_buffer(subprocess.list2cmdline(command))
        checked(k.CreateProcessW(command[0], command_line, None, None, True,
                                 EXTENDED_STARTUP | NO_WINDOW | UNICODE_ENVIRONMENT,
                                 environment, None, ctypes.byref(startup), ctypes.byref(process)), 'bounded-launch-rejected')
        handles.extend([process.hProcess, process.hThread])
        child_job = W.BOOL()
        checked(k.IsProcessInJob(process.hProcess, job, ctypes.byref(child_job)), 'child-job-query-failed')
        if not child_job.value:
            raise BoundedExecutionError('child-job-unverified')
        close(stdin_read)
        close(stdout_write)
        close(stderr_write)
        threads = [threading.Thread(target=reader, args=(stdout_read, limits.stdout_bytes, output), daemon=True),
                   threading.Thread(target=reader, args=(stderr_read, limits.stderr_bytes, errors), daemon=True),
                   threading.Thread(target=writer, args=(stdin_write,), daemon=True)]
        for thread in threads:
            thread.start()
        reason = None
        while True:
            if violation.is_set():
                reason = 'output-limit'
                break
            if pipe_error.is_set():
                reason = 'pipe-unavailable'
                break
            if time.monotonic() >= deadline:
                reason = 'wall-deadline'
                break
            wait = k.WaitForSingleObject(process.hProcess, 10)
            if wait == 0:
                break
            if wait != WAIT_TIMEOUT:
                reason = 'process-wait-failed'
                break
        # Even a root that exits successfully cannot leave descendants running.
        checked(k.TerminateJobObject(job, 1 if reason else 0), 'tree-cleanup-failed')
        cleanup_deadline, accounting = time.monotonic() + 2, Accounting()
        while time.monotonic() < cleanup_deadline:
            checked(k.QueryInformationJobObject(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None), 'tree-cleanup-unverified')
            if accounting.ActiveProcesses == 0:
                break
            time.sleep(0.005)
        if accounting.ActiveProcesses:
            raise BoundedExecutionError('tree-cleanup-unverified')
        for thread in threads:
            thread.join(timeout=max(0, cleanup_deadline - time.monotonic()))
        if any(thread.is_alive() for thread in threads):
            raise BoundedExecutionError('pipe-cleanup-unverified')
        checked(k.QueryInformationJobObject(job, 9, ctypes.byref(verified), ctypes.sizeof(verified), None), 'memory-accounting-unavailable')
        exit_code = W.DWORD()
        checked(k.GetExitCodeProcess(process.hProcess, ctypes.byref(exit_code)), 'process-exit-unavailable')
        execution = {'mode': 'windows-job-object', 'memoryMeaning': 'committed-virtual-memory',
                     'processMemoryLimitBytes': limits.process_memory_bytes, 'jobMemoryLimitBytes': limits.job_memory_bytes,
                     'processesLimit': limits.processes, 'wallSeconds': limits.wall_seconds,
                     'inputBytesLimit': limits.input_bytes, 'stdoutBytesLimit': limits.stdout_bytes, 'stderrBytesLimit': limits.stderr_bytes,
                     'nativeReportedPeakProcessBytes': verified.PeakProcessMemoryUsed, 'nativeReportedPeakJobBytes': verified.PeakJobMemoryUsed,
                     'activeProcessesAfterCleanup': accounting.ActiveProcesses, 'jobListAppliedBeforeExecution': True,
                     'hostAlreadyInJob': bool(parent_job.value),
                     'exitCode': exit_code.value, 'environment': 'minimal-without-producer-credentials'}
        if violation.is_set():
            reason = 'output-limit'
        if pipe_error.is_set() and reason is None:
            reason = 'pipe-unavailable'
        if reason or exit_code.value:
            raise BoundedExecutionError(reason or 'process-failed', execution)
        return {'stdout': b''.join(output), 'stderr': b''.join(errors), 'execution': execution}
    finally:
        if job:
            k.TerminateJobObject(job, 1)
        if attributes_live:
            k.DeleteProcThreadAttributeList(attributes)
        for handle in list(handles):
            close(handle)


def main():
    if sys.argv[1:] not in ([], ['--include-original']):
        raise BoundedExecutionError('fixed-stdin-extractor-only')
    start, limits = time.monotonic(), Limits()
    raw = read_bounded_stdin(limits.input_bytes, start + limits.wall_seconds)
    extractor = str(pathlib.Path(__file__).with_name('extract-ec-document.py').resolve())
    result = run_in_job([sys.executable, '-I', '-B', extractor, *sys.argv[1:]], raw, limits, start + limits.wall_seconds)
    try:
        artifact = json.loads(result['stdout'])
    except Exception:
        raise BoundedExecutionError('extractor-envelope-invalid') from None
    value = {'schemaVersion': 1, 'policyId': 'ec-statement-pdf-v1', 'execution': result['execution'], 'result': artifact}
    output = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(output) > limits.stdout_bytes:
        raise BoundedExecutionError('output-limit')
    sys.stdout.buffer.write(output)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('Bounded Windows document execution failed; no artifact published.\n')
        sys.exit(1)
