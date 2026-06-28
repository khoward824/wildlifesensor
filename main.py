#!/usr/bin/env python3
"""Python 3 starter — AgentFlow IDE"""

import json
import logging
import sys
from typing import Any, Dict, Iterator, List, Optional, Union

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

def greet(name: str) -> str:
    """Return a personalised greeting.

    Args:
        name: The name to greet.

    Returns:
        A greeting string.

    Raises:
        TypeError: If *name* is not a string.
        ValueError: If *name* is empty or contains only whitespace.
    """
    if not isinstance(name, str):
        raise TypeError(f"name must be a str, got {type(name).__name__!r}")
    name = name.strip()
    if not name:
        raise ValueError("name must not be empty or blank")
    return f"Hello, {name}!"


def factorial(n: int) -> int:
    """Return the factorial of *n* (n!).

    Iterative implementation to avoid hitting Python's default recursion
    limit for large values of *n*.

    Args:
        n: A non-negative integer.

    Returns:
        The factorial of *n*.

    Raises:
        TypeError: If *n* is not an integer.
        ValueError: If *n* is negative.
    """
    if not isinstance(n, int) or isinstance(n, bool):
        raise TypeError(f"n must be an int, got {type(n).__name__!r}")
    if n < 0:
        raise ValueError(f"factorial is not defined for negative numbers, got {n}")

    result = 1
    for i in range(2, n + 1):
        result *= i
    return result


# ---------------------------------------------------------------------------
# Person class
# ---------------------------------------------------------------------------

class Person:
    """Represents a person with a name and age."""

    # Sensible bounds for validation
    _MAX_AGE: int = 150
    _MIN_AGE: int = 0

    def __init__(self, name: str, age: int) -> None:
        """Initialise a Person.

        Args:
            name: Full name of the person.
            age: Age in years (0 – 150 inclusive).

        Raises:
            TypeError: If *name* is not a str or *age* is not an int.
            ValueError: If *name* is blank or *age* is out of the valid range.
        """
        if not isinstance(name, str):
            raise TypeError(f"name must be a str, got {type(name).__name__!r}")
        name = name.strip()
        if not name:
            raise ValueError("name must not be empty or blank")

        if not isinstance(age, int) or isinstance(age, bool):
            raise TypeError(f"age must be an int, got {type(age).__name__!r}")
        if not (self._MIN_AGE <= age <= self._MAX_AGE):
            raise ValueError(
                f"age must be between {self._MIN_AGE} and {self._MAX_AGE}, got {age}"
            )

        self.name: str = name
        self.age: int = age

    # ------------------------------------------------------------------
    # Dunder helpers
    # ------------------------------------------------------------------

    def __repr__(self) -> str:
        return f"Person(name={self.name!r}, age={self.age})"

    def __str__(self) -> str:
        return f"{self.name} (age {self.age})"

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Person):
            return NotImplemented
        return self.name == other.name and self.age == other.age

    def __hash__(self) -> int:
        return hash((self.name, self.age))

    def __lt__(self, other: "Person") -> bool:
        if not isinstance(other, Person):
            return NotImplemented
        return (self.age, self.name) < (other.age, other.name)

    # ------------------------------------------------------------------
    # Serialisation helpers
    # ------------------------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        """Serialise to a plain dictionary."""
        return {"name": self.name, "age": self.age}

    def to_json(self, *, indent: Optional[int] = 2) -> str:
        """Serialise to a JSON string."""
        return json.dumps(self.to_dict(), indent=indent)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Person":
        """Deserialise from a plain dictionary.

        Args:
            data: Dictionary with at least ``name`` and ``age`` keys.

        Returns:
            A new :class:`Person` instance.

        Raises:
            KeyError: If required keys are missing.
            TypeError / ValueError: If the values fail validation.
        """
        try:
            return cls(name=data["name"], age=data["age"])
        except KeyError as exc:
            raise KeyError(f"Missing required field: {exc}") from exc

    @classmethod
    def from_json(cls, payload: str) -> "Person":
        """Deserialise from a JSON string.

        Args:
            payload: A JSON-encoded person object.

        Returns:
            A new :class:`Person` instance.

        Raises:
            json.JSONDecodeError: If *payload* is not valid JSON.
            KeyError / TypeError / ValueError: Propagated from :meth:`from_dict`.
        """
        try:
            data = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise json.JSONDecodeError(
                f"Invalid JSON payload: {exc.msg}", exc.doc, exc.pos
            ) from exc
        if not isinstance(data, dict):
            raise TypeError(f"Expected a JSON object, got {type(data).__name__!r}")
        return cls.from_dict(data)

    # ------------------------------------------------------------------
    # Business logic helpers
    # ------------------------------------------------------------------

    def is_adult(self, threshold: int = 18) -> bool:
        """Return *True* if the person is at least *threshold* years old."""
        return self.age >= threshold

    def birthday(self) -> "Person":
        """Return a new :class:`Person` with age incremented by one year.

        Raises:
            ValueError: If incrementing age would exceed the maximum allowed.
        """
        if self.age >= self._MAX_AGE:
            raise ValueError(
                f"Cannot increment age beyond maximum of {self._MAX_AGE}"
            )
        return Person(name=self.name, age=self.age + 1)


# ---------------------------------------------------------------------------
# Collection helpers
# ---------------------------------------------------------------------------

def sort_people(
    people: List[Person],
    *,
    key: str = "age",
    reverse: bool = False,
) -> List[Person]:
    """Return a sorted copy of *people*.

    Args:
        people: List of :class:`Person` objects.
        key: Attribute to sort by — ``"age"`` or ``"name"``.
        reverse: If *True*, sort in descending order.

    Returns:
        A new sorted list.

    Raises:
        TypeError: If *people* is not a list or contains non-Person items.
        ValueError: If *key* is not ``"age"`` or ``"name"``.
    """
    if not isinstance(people, list):
        raise TypeError(f"people must be a list, got {type(people).__name__!r}")
    if not all(isinstance(p, Person) for p in people):
        raise TypeError("All elements in people must be Person instances")
    if key not in {"age", "name"}:
        raise ValueError(f"key must be 'age' or 'name', got {key!r}")

    return sorted(people, key=lambda p: getattr(p, key), reverse=reverse)


def filter_adults(
    people: List[Person],
    *,
    threshold: int = 18,
) -> List[Person]:
    """Return only those people whose age is at least *threshold*.

    Args:
        people: List of :class:`Person` objects.
        threshold: Minimum age (inclusive) to be considered an adult.

    Returns:
        Filtered list.
    """
    if not isinstance(people, list):
        raise TypeError(f"people must be a list, got {type(people).__name__!r}")
    return [p for p in people if p.is_adult(threshold)]


def people_to_json(people: List[Person], *, indent: Optional[int] = 2) -> str:
    """Serialise a list of :class:`Person` objects to a JSON array string."""
    return json.dumps([p.to_dict() for p in people], indent=indent)


def people_from_json(payload: str) -> List[Person]:
    """Deserialise a JSON array string into a list of :class:`Person` objects.

    Raises:
        json.JSONDecodeError: If *payload* is not valid JSON.
        TypeError: If the top-level value is not a JSON array.
    """
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise json.JSONDecodeError(
            f"Invalid JSON payload: {exc.msg}", exc.doc, exc.pos
        ) from exc
    if not isinstance(data, list):
        raise TypeError(f"Expected a JSON array, got {type(data).__name__!r}")
    return [Person.from_dict(item) for item in data]


# ---------------------------------------------------------------------------
# Batch iterator
# ---------------------------------------------------------------------------

def batched(items: List[Any], size: int) -> Iterator[List[Any]]:
    """Yield successive non-overlapping batches of *size* from *items*.

    Args:
        items: Source list.
        size: Maximum number of elements per batch (must be >= 1).

    Yields:
        Sublists of at most *size* elements.

    Raises:
        ValueError: If *size* is less than 1.
    """
    if size < 1:
        raise ValueError(f"size must be >= 1, got {size}")
    for start in range(0, len(items), size):
        yield items[start : start + size]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv: Optional[List[str]] = None) -> int:  # noqa: C901
    """Run a self-contained demonstration of every feature in this module.

    Args:
        argv: Optional argument list (currently unused; reserved for future CLI
              option parsing).

    Returns:
        Exit code — ``0`` on success, ``1`` on unexpected error.
    """
    try:
        # -- greet ----------------------------------------------------------
        logger.info("=== greet ===")
        print(greet("World"))
        print(greet("  AgentFlow  "))  # strips whitespace

        # -- factorial ------------------------------------------------------
        logger.info("=== factorial ===")
        for n in (0, 1, 5, 10, 20):
            print(f"{n:>2}! = {factorial(n)}")

        # -- Person creation ------------------------------------------------
        logger.info("=== Person ===")
        people: List[Person] = [
            Person("Alice", 30),
            Person("Bob", 25),
            Person("Charlie", 17),
            Person("Diana", 42),
        ]
        for p in people:
            print(p)

        # -- serialisation round-trip ---------------------------------------
        logger.info("=== JSON round-trip ===")
        json_str = people_to_json(people)
        restored = people_from_json(json_str)
        assert restored == people, "Round-trip serialisation mismatch"
        print("JSON round-trip: OK")

        # individual to/from JSON
        alice = people[0]
        assert Person.from_json(alice.to_json()) == alice
        print(f"Individual round-trip: {alice.to_json(indent=None)}")

        # -- from_dict ------------------------------------------------------
        logger.info("=== from_dict ===")
        p_dict = {"name": "Eve", "age": 28}
        eve = Person.from_dict(p_dict)
        print(f"from_dict: {eve}")

        # -- sorting --------------------------------------------------------
        logger.info("=== sort_people ===")
        by_age = sort_people(people, key="age")
        print("Sorted by age:", by_age)
        by_name_desc = sort_people(people, key="name", reverse=True)
        print("Sorted by name (desc):", by_name_desc)

        # -- filtering ------------------------------------------------------
        logger.info("=== filter_adults ===")
        adults = filter_adults(people)
        print("Adults (>= 18):", adults)
        minors = [p for p in people if not p.is_adult()]
        print("Minors:", minors)

        # -- birthday -------------------------------------------------------
        logger.info("=== birthday ===")
        older_alice = alice.birthday()
        print(f"After birthday: {older_alice}")

        # -- batched --------------------------------------------------------
        logger.info("=== batched ===")
        for batch in batched(people, 2):
            print("Batch:", batch)

        # -- individual JSON dump (original demo) ---------------------------
        logger.info("=== raw JSON dump ===")
        for p in people:
            print(json.dumps(p.to_dict(), indent=2))

        # -- error-handling smoke tests ------------------------------------
        logger.info("=== edge-case validation smoke tests ===")
        _run_validation_smoke_tests()

        logger.info("All checks passed.")
        return 0

    except Exception:  # pylint: disable=broad-except
        logger.exception("Unhandled exception in main")
        return 1


def _run_validation_smoke_tests() -> None:
    """Exercise validation paths to confirm errors are raised correctly."""

    def _expect(exc_type: type, fn: Any, *args: Any, **kwargs: Any) -> None:
        try:
            fn(*args, **kwargs)
        except exc_type:
            pass  # expected
        else:
            raise AssertionError(
                f"Expected {exc_type.__name__} from {fn.__name__}{args}{kwargs}"
            )

    # greet
    _expect(TypeError, greet, 123)
    _expect(ValueError, greet, "   ")

    # factorial
    _expect(TypeError, factorial, 3.5)
    _expect(TypeError, factorial, True)  # bool subclass guard
    _expect(ValueError, factorial, -1)

    # Person constructor
    _expect(TypeError, Person, 42, 30)
    _expect(ValueError, Person, "", 30)
    _expect(TypeError, Person, "X", "old")
    _expect(ValueError, Person, "X", -1)
    _expect(ValueError, Person, "X", 151)

    # Person.from_dict
    _expect(KeyError, Person.from_dict, {"name": "X"})

    # Person.from_json
    _expect(json.JSONDecodeError, Person.from_json, "{bad json}")
    _expect(TypeError, Person.from_json, "[1, 2]")

    # sort_people
    _expect(ValueError, sort_people, [], key="height")

    # batched
    _expect(ValueError, batched, [], 0)

    print("Validation smoke tests: OK")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
