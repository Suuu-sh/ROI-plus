"""Small NumPy-only binary logistic regression for candidate learning.

The estimator uses the same summed logistic-loss and L2 penalty convention as
``sklearn.linear_model.LogisticRegression`` with ``fit_intercept=False``:

    sum(log(1 + exp(X @ w)) - y * (X @ w)) + ||w||**2 / (2 * C)

It is intentionally a small, pickle-safe sklearn-like object, not a general
replacement for scikit-learn.
"""
from __future__ import annotations

import numpy as np


class NumpyLogisticRegression:
    """Fit binary logistic regression using damped Newton iterations.

    Parameters follow the relevant subset of sklearn's estimator API. The
    intercept is deliberately unsupported because the learning objective this
    replaces has no intercept.
    """

    def __init__(self, C: float = 0.25, fit_intercept: bool = False,
                 max_iter: int = 1000, tol: float = 1e-10):
        self.C = C
        self.fit_intercept = fit_intercept
        self.max_iter = max_iter
        self.tol = tol

    @staticmethod
    def _sigmoid(logits: np.ndarray) -> np.ndarray:
        # exp(-logaddexp(0, -z)) is stable for either sign of z.
        return np.exp(-np.logaddexp(0.0, -logits))

    def _objective(self, x: np.ndarray, y: np.ndarray, weights: np.ndarray) -> float:
        logits = x @ weights
        return float(np.sum(np.logaddexp(0.0, logits) - y * logits)
                     + (weights @ weights) / (2.0 * self.C))

    def fit(self, X, y):
        """Fit on a finite 2-D feature matrix and binary labels."""
        if not np.isfinite(self.C) or self.C <= 0:
            raise ValueError("C must be a finite positive number")
        if self.fit_intercept:
            raise ValueError("fit_intercept=True is unsupported; this estimator has no intercept")
        if not isinstance(self.max_iter, (int, np.integer)) or self.max_iter < 1:
            raise ValueError("max_iter must be a positive integer")
        if not np.isfinite(self.tol) or self.tol <= 0:
            raise ValueError("tol must be a finite positive number")

        x = np.asarray(X, dtype=np.float64)
        labels = np.asarray(y)
        if x.ndim != 2 or x.shape[0] == 0 or x.shape[1] == 0:
            raise ValueError("X must be a non-empty 2-D matrix")
        if labels.ndim != 1 or labels.shape[0] != x.shape[0]:
            raise ValueError("y must be a 1-D vector with one label per row of X")
        if not np.isfinite(x).all():
            raise ValueError("X must contain only finite values")
        if labels.dtype.kind not in "biufUS":
            raise ValueError("y must contain supported numeric or string labels")
        if labels.dtype.kind in "iuf" and not np.isfinite(labels).all():
            raise ValueError("y must contain only finite labels")
        try:
            classes = np.unique(labels)
        except (TypeError, ValueError) as exc:
            raise ValueError("y must contain exactly two comparable classes") from exc
        if classes.size != 2:
            raise ValueError("y must contain exactly two classes")
        try:
            binary_y = (labels == classes[1]).astype(np.float64)
        except (TypeError, ValueError) as exc:
            raise ValueError("y must contain exactly two comparable classes") from exc

        weights = np.zeros(x.shape[1], dtype=np.float64)
        converged = False
        gradient_norm = float("inf")
        objective = self._objective(x, binary_y, weights)
        identity = np.eye(x.shape[1], dtype=np.float64) / self.C

        for iteration in range(1, self.max_iter + 1):
            probabilities = self._sigmoid(x @ weights)
            gradient = x.T @ (probabilities - binary_y) + weights / self.C
            gradient_norm = float(np.max(np.abs(gradient)))
            if gradient_norm <= self.tol:
                converged = True
                break

            curvature = probabilities * (1.0 - probabilities)
            hessian = (x.T @ (x * curvature[:, None])) + identity
            try:
                step = np.linalg.solve(hessian, gradient)
            except np.linalg.LinAlgError as exc:
                raise RuntimeError("Newton Hessian solve failed") from exc
            directional_derivative = float(gradient @ step)
            if not np.isfinite(step).all() or not np.isfinite(directional_derivative):
                raise RuntimeError("Newton step became non-finite")
            if directional_derivative <= 0.0:
                raise RuntimeError("Newton direction is not a descent direction")

            # Armijo backtracking ensures each accepted update decreases the
            # convex objective, including for badly scaled but finite inputs.
            rate = 1.0
            accepted = False
            while rate >= 2.0 ** -40:
                candidate = weights - rate * step
                candidate_objective = self._objective(x, binary_y, candidate)
                if (np.isfinite(candidate_objective)
                        and candidate_objective <= objective - 1e-4 * rate * directional_derivative):
                    weights = candidate
                    objective = candidate_objective
                    accepted = True
                    break
                rate *= 0.5
            if not accepted:
                # A full-precision iterate can be at the numerical optimum
                # even if the requested tolerance is below representable
                # objective changes; accept only a small residual here.
                if gradient_norm <= max(self.tol * 10.0, 1e-12):
                    converged = True
                    break
                raise RuntimeError("logistic regression line search failed")

        # Recompute the residual at the final iterate (including after the
        # last allowed update) before declaring convergence.
        probabilities = self._sigmoid(x @ weights)
        gradient = x.T @ (probabilities - binary_y) + weights / self.C
        gradient_norm = float(np.max(np.abs(gradient)))
        converged = converged or gradient_norm <= self.tol
        if not converged:
            raise RuntimeError(
                f"logistic regression did not converge in {self.max_iter} iterations "
                f"(gradient infinity norm={gradient_norm:.3g}, tolerance={self.tol:.3g})")

        self.classes_ = classes.copy()
        self.coef_ = weights.reshape(1, -1)
        self.n_features_in_ = x.shape[1]
        self.n_iter_ = np.asarray([iteration], dtype=np.int32)
        self.converged_ = True
        self.gradient_norm_ = gradient_norm
        self.objective_ = self._objective(x, binary_y, weights)
        return self

    def predict_proba(self, X) -> np.ndarray:
        """Return probabilities in ascending ``classes_`` order."""
        if not hasattr(self, "coef_"):
            raise RuntimeError("estimator is not fitted")
        x = np.asarray(X, dtype=np.float64)
        if x.ndim != 2 or x.shape[1] != self.n_features_in_:
            raise ValueError(f"X must have shape (n_samples, {self.n_features_in_})")
        if not np.isfinite(x).all():
            raise ValueError("X must contain only finite values")
        positive = self._sigmoid(x @ self.coef_[0])
        return np.column_stack((1.0 - positive, positive))

