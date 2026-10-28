"""Build Blender node trees from Python with readable math.

    t = Tree("SF Example")
    geo = t.input("Geometry", "GEOMETRY")
    h = t.input("Height", "FLOAT", 1.0)
    p = t.position()
    with t.section("Wave"):
        z = t.sin(p.x * 0.5) * h
    t.output("Geometry", "GEOMETRY", t.set_position(geo, offset=t.vec(0, 0, z)))

Arithmetic on sockets creates Math / Vector Math nodes; plain Python numbers
become socket default values. Nodes are laid out in columns by dependency
depth, and `section()` wraps them in a labelled frame so the generated graphs
stay readable when you open them in Blender.
"""

from __future__ import annotations

import math
from contextlib import contextmanager

import bpy

SOCKET_TYPES = {
    "FLOAT": "NodeSocketFloat",
    "INT": "NodeSocketInt",
    "BOOLEAN": "NodeSocketBool",
    "VECTOR": "NodeSocketVector",
    "COLOR": "NodeSocketColor",
    "STRING": "NodeSocketString",
    "GEOMETRY": "NodeSocketGeometry",
    "MATERIAL": "NodeSocketMaterial",
    "OBJECT": "NodeSocketObject",
    "SHADER": "NodeSocketShader",
}

# Store / Named Attribute data types for each socket type.
ATTRIBUTE_TYPES = {"VALUE": "FLOAT", "VECTOR": "FLOAT_VECTOR", "BOOLEAN": "BOOLEAN", "INT": "INT", "RGBA": "FLOAT_COLOR"}

COLUMN_WIDTH = 200
COMPACT = {"ShaderNodeMath", "ShaderNodeVectorMath", "ShaderNodeCombineXYZ", "ShaderNodeSeparateXYZ",
           "ShaderNodeClamp", "FunctionNodeBooleanMath", "FunctionNodeCompare"}


def is_vector(value) -> bool:
    if isinstance(value, Socket):
        return value.socket.type in ("VECTOR", "RGBA")    # colours do vector math too
    return isinstance(value, (tuple, list)) and len(value) == 3


class Socket:
    """An output socket. Arithmetic on it adds nodes to its tree."""

    __slots__ = ("tree", "socket", "_xyz")

    def __init__(self, tree: "Tree", socket):
        self.tree = tree
        self.socket = socket
        self._xyz = None

    def __add__(self, o): return self.tree.arith("ADD", self, o)
    def __radd__(self, o): return self.tree.arith("ADD", o, self)
    def __sub__(self, o): return self.tree.arith("SUBTRACT", self, o)
    def __rsub__(self, o): return self.tree.arith("SUBTRACT", o, self)
    def __mul__(self, o): return self.tree.arith("MULTIPLY", self, o)
    def __rmul__(self, o): return self.tree.arith("MULTIPLY", o, self)
    def __truediv__(self, o): return self.tree.arith("DIVIDE", self, o)
    def __rtruediv__(self, o): return self.tree.arith("DIVIDE", o, self)
    def __pow__(self, o): return self.tree.math("POWER", self, o)
    def __neg__(self): return self.tree.arith("MULTIPLY", self, -1.0)

    def _split(self):
        if self._xyz is None:
            node = self.tree.node("ShaderNodeSeparateXYZ", [self])
            self._xyz = tuple(Socket(self.tree, node.outputs[i]) for i in range(3))
        return self._xyz

    @property
    def x(self): return self._split()[0]
    @property
    def y(self): return self._split()[1]
    @property
    def z(self): return self._split()[2]


class Tree:
    def __init__(self, name: str, kind: str = "GeometryNodeTree", description: str = ""):
        nt = bpy.data.node_groups.get(name)
        if nt is None or nt.bl_idname != kind:
            nt = bpy.data.node_groups.new(name, kind)
        nt.nodes.clear()
        nt.interface.clear()
        if kind == "GeometryNodeTree":
            nt.is_modifier = True
        nt.description = description
        self.nt = nt
        self.group_in = nt.nodes.new("NodeGroupInput")
        self.group_out = nt.nodes.new("NodeGroupOutput")
        self._depth = {self.group_in.name: 0}
        self._frame = None
        self._section_top = 0.0
        self._column_y = {}
        self._bottom = 0.0
        self.group_in.location = (-COLUMN_WIDTH, 0)

    # ------------------------------------------------------------ interface

    def input(self, name, kind, default=None, min=None, max=None, description="", subtype=None):
        item = self.nt.interface.new_socket(name, in_out="INPUT", socket_type=SOCKET_TYPES[kind])
        if subtype:
            item.subtype = subtype
        if default is not None:
            item.default_value = default
        if min is not None:
            item.min_value = min
        if max is not None:
            item.max_value = max
        item.description = description
        return Socket(self, self.group_in.outputs[name])

    def output(self, name, kind, value, description=""):
        item = self.nt.interface.new_socket(name, in_out="OUTPUT", socket_type=SOCKET_TYPES[kind])
        item.description = description
        self.link(value, self.group_out.inputs[name])

    def finish(self):
        """Place the group output after the deepest node."""
        deepest = max(self._depth.values(), default=0)
        self.group_out.location = ((deepest + 1) * COLUMN_WIDTH, 0)
        return self.nt

    # ------------------------------------------------------------ layout

    @contextmanager
    def section(self, label: str):
        """Wrap nodes created inside in a labelled frame, in their own band."""
        frame = self.nt.nodes.new("NodeFrame")
        frame.label = label
        frame.label_size = 20
        frame.shrink = True
        previous = (self._frame, self._column_y, self._section_top)
        self._frame = frame
        self._section_top = self._bottom - 60
        self._column_y = {}
        try:
            yield
        finally:
            self._frame, self._column_y, self._section_top = previous
            if self._frame is None:
                self._section_top = self._bottom - 60

    def _place(self, node, inputs):
        depth = 1 + max((self._depth.get(s.socket.node.name, 0) for s in inputs if isinstance(s, Socket)), default=0)
        self._depth[node.name] = depth
        compact = node.bl_idname in COMPACT
        if compact:
            node.hide = True
        y = self._column_y.get(depth, self._section_top)
        node.location = (depth * COLUMN_WIDTH, y)
        step = 44 if compact else 60 + 22 * sum(1 for s in node.inputs if s.enabled and not s.hide) + 22 * len(node.outputs)
        self._column_y[depth] = y - step
        self._bottom = min(self._bottom, y - step)
        if self._frame is not None:
            node.parent = self._frame

    # ------------------------------------------------------------ nodes

    def node(self, kind, inputs=(), label=None, **props):
        """Create a node, set properties, link inputs (list by position or dict by name)."""
        node = self.nt.nodes.new(kind)
        for key, value in props.items():
            setattr(node, key, value)
        values = list(inputs.values()) if isinstance(inputs, dict) else list(inputs)
        self._place(node, values)
        if isinstance(inputs, dict):
            for key, value in inputs.items():
                self.link(value, node.inputs[key])
        else:
            enabled = [s for s in node.inputs if s.enabled]
            for socket, value in zip(enabled, inputs):
                self.link(value, socket)
        if label:
            node.label = label
        return node

    def join(self, *geometries):
        node = self.nt.nodes.new("GeometryNodeJoinGeometry")
        self._place(node, list(geometries))
        for g in geometries:
            self.link(g, node.inputs[0])
        return self.out(node)

    def link(self, value, socket):
        if value is None:
            return
        if isinstance(value, Socket):
            self.nt.links.new(value.socket, socket)
        elif isinstance(value, (tuple, list)) and socket.type == "VECTOR":
            socket.default_value = tuple(float(v) for v in value)
        else:
            socket.default_value = value

    def out(self, node, index=0):
        return Socket(self, node.outputs[index])

    # ------------------------------------------------------------ math

    def math(self, op, a, b=None, c=None, label=None):
        # Enabled sockets follow the operation, so pass only the operands used.
        operands = [v for v in (a, b, c) if v is not None]
        return self.out(self.node("ShaderNodeMath", operands, operation=op, label=label))

    def vmath(self, op, a, b=None, scale=None, output=0, label=None):
        operands = [v for v in (a, b, scale) if v is not None]
        return self.out(self.node("ShaderNodeVectorMath", operands, operation=op, label=label), output)

    def arith(self, op, a, b):
        if not is_vector(a) and not is_vector(b):
            return self.math(op, a, b)
        if is_vector(a) and is_vector(b):
            return self.vmath(op, a, b)
        vec, sc = (a, b) if is_vector(a) else (b, a)
        if op == "MULTIPLY":
            return self.vmath("SCALE", vec, scale=sc)
        if op == "DIVIDE" and is_vector(a):
            return self.vmath("SCALE", a, scale=self.math("DIVIDE", 1.0, b))
        broadcast = self.vec(sc, sc, sc)
        return self.vmath(op, a if is_vector(a) else broadcast, b if is_vector(b) else broadcast)

    def sin(self, x): return self.math("SINE", x)
    def cos(self, x): return self.math("COSINE", x)
    def sqrt(self, x): return self.math("SQRT", x)
    def exp(self, x): return self.math("EXPONENT", x)
    def abs(self, x): return self.math("ABSOLUTE", x)
    def floor(self, x): return self.math("FLOOR", x)
    def fract(self, x): return self.math("FRACT", x)
    def min(self, a, b): return self.math("MINIMUM", a, b)
    def max(self, a, b): return self.math("MAXIMUM", a, b)
    def greater(self, a, b): return self.math("GREATER_THAN", a, b)
    def less(self, a, b): return self.math("LESS_THAN", a, b)

    def clamp(self, x, lo=0.0, hi=1.0):
        return self.out(self.node("ShaderNodeClamp", [x, lo, hi]))

    def smoothstep(self, edge0, edge1, x):
        """0 below edge0, 1 above edge1, smooth in between (GLSL smoothstep)."""
        node = self.node("ShaderNodeMapRange", {"Value": x, "From Min": edge0, "From Max": edge1},
                         interpolation_type="SMOOTHSTEP", clamp=True)
        return self.out(node)

    def mix(self, a, b, t):
        return a + (b - a) * t

    def vec(self, x=0.0, y=0.0, z=0.0):
        return self.out(self.node("ShaderNodeCombineXYZ", [x, y, z]))

    def dot(self, a, b): return self.vmath("DOT_PRODUCT", a, b, output=1)
    def length(self, a): return self.vmath("LENGTH", a, output=1)

    # ------------------------------------------------------------ geometry helpers

    def position(self):
        return self.out(self.node("GeometryNodeInputPosition"))

    def index(self):
        return self.out(self.node("GeometryNodeInputIndex"))

    def scene_time(self):
        node = self.node("GeometryNodeInputSceneTime")
        return Socket(self, node.outputs[0]), Socket(self, node.outputs[1])

    def named(self, name, data_type="FLOAT"):
        node = self.node("GeometryNodeInputNamedAttribute", {"Name": name}, data_type=data_type)
        return Socket(self, node.outputs[0]), Socket(self, node.outputs[1])

    def store(self, geometry, name, value, domain="POINT"):
        data_type = ATTRIBUTE_TYPES.get(value.socket.type, "FLOAT") if isinstance(value, Socket) else "FLOAT"
        node = self.node("GeometryNodeStoreNamedAttribute", {"Geometry": geometry, "Name": name, "Value": value},
                         data_type=data_type, domain=domain)
        return self.out(node)

    def remove_attributes(self, geometry, name, wildcard=False):
        node = self.node("GeometryNodeRemoveAttribute", {"Geometry": geometry, "Name": name})
        if wildcard:
            if hasattr(node, "pattern_mode"):              # Blender 4.x: node property
                node.pattern_mode = "WILDCARD"
            else:                                          # Blender 5.x: menu socket
                node.inputs["Pattern Mode"].default_value = "Wildcard"
        return self.out(node)

    def set_position(self, geometry, position=None, offset=None, selection=None):
        inputs = {"Geometry": geometry}
        if position is not None:
            inputs["Position"] = position
        if offset is not None:
            inputs["Offset"] = offset
        if selection is not None:
            inputs["Selection"] = selection
        return self.out(self.node("GeometryNodeSetPosition", inputs))

    def noise(self, vector=None, w=None, scale=1.0, detail=2.0, dimensions="2D", output=0):
        inputs = {"Scale": scale, "Detail": detail}
        if vector is not None:
            inputs["Vector"] = vector
        if w is not None:
            inputs["W"] = w
        node = self.node("ShaderNodeTexNoise", inputs, noise_dimensions=dimensions)
        return self.out(node, output)


TAU = 2 * math.pi
GRAVITY = 9.81
