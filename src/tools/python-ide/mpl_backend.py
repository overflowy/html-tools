"""matplotlib backend for the Interpreter: plt.show() renders every open
figure to PNG and hands it to the host, then closes it, the way closing the
windows of a desktop backend would. Selected through MPLBACKEND, so it costs
nothing until matplotlib is imported."""

import io

from matplotlib import _pylab_helpers
from matplotlib.backend_bases import FigureManagerBase
from matplotlib.backends.backend_agg import FigureCanvasAgg
from pyodide.ffi import to_js

import pyide_host

FigureCanvas = FigureCanvasAgg
FigureManager = FigureManagerBase


def show(*args, **kwargs):
    managers = _pylab_helpers.Gcf.get_all_fig_managers()
    for manager in managers:
        figure = manager.canvas.figure
        buf = io.BytesIO()
        figure.savefig(buf, format="png", dpi=figure.dpi * 2, facecolor=figure.get_facecolor())
        pyide_host.emitFigure(to_js(buf.getvalue()))
    _pylab_helpers.Gcf.destroy_all()
