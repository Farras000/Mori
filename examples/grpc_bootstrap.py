"""Import this module to get ready-to-use generated gRPC stubs.

Usage (from an example in this directory):
    import grpc_bootstrap as gen
    pb, rpc = gen.pb, gen.rpc

On first use the `mori_pb2*.py` stubs are generated with grpc_tools
(requires `pip install grpcio grpcio-tools`). The examples directory
must be on `sys.path` before importing this module.
"""

import os
import subprocess
import sys


def _ensure_stubs() -> None:
    try:
        import mori_pb2  # noqa: F401
        return
    except ImportError:
        pass
    try:
        import grpc_tools  # noqa: F401
    except ImportError as e:
        raise SystemExit("grpcio-tools missing: pip install grpcio grpcio-tools") from e
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "grpc_tools.protoc",
            "-I",
            os.path.join(root, "proto"),
            f"--python_out={here}",
            f"--grpc_python_out={here}",
            os.path.join(root, "proto", "mori.proto"),
        ],
        check=True,
    )


_ensure_stubs()

import mori_pb2 as pb  # noqa: E402
import mori_pb2_grpc as rpc  # noqa: E402
